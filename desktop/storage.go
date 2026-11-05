package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/egoist/mygo"
)

// Browser storage is deliberately not consulted: this owns only mygo business
// data. Neither persisted file paths nor these records confer file capabilities.
const (
	applicationStorageDirectory  = "business-data-v1"
	applicationStorageValueLimit = 64 << 20
)

var applicationStorageNamespaces = []string{
	"renderer", "music-data/music", "user-data/user", "local-data/local",
	"local-data/local_download_history", "background-data/background",
}

type StorageValue struct {
	Kind      string `json:"kind"`
	Value     string `json:"value"`
	MediaType string `json:"mediaType"`
}

type storageHeader struct {
	Version   int    `json:"version"`
	Key       string `json:"key"`
	Kind      string `json:"kind"`
	MediaType string `json:"mediaType"`
}

type applicationStorage struct {
	mu               sync.Mutex
	root             string
	frozen           context.Context
	recoveryRequired bool
	renameTree       func(string, string) error
}

var businessStorage = &applicationStorage{}

type DesktopStorage struct{}

func init() { mygo.Bind(&DesktopStorage{}) }

func prepareApplicationStorage(directory string) error {
	businessStorage.mu.Lock()
	defer businessStorage.mu.Unlock()
	root := filepath.Join(directory, applicationStorageDirectory)
	if err := recoverApplicationStorageImport(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid application storage directory")
	}
	businessStorage.root = root
	return nil
}

func storageNamespace(name string) bool {
	return slices.Contains(applicationStorageNamespaces, name)
}

func storageDigest(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func (s *applicationStorage) directory(namespace string) (string, error) {
	if s.root == "" || !storageNamespace(namespace) {
		return "", errors.New("application storage unavailable")
	}
	return filepath.Join(s.root, storageDigest(namespace)), nil
}

func (s *applicationStorage) path(namespace, key string) (string, error) {
	directory, err := s.directory(namespace)
	if err != nil {
		return "", err
	}
	if key == "" || len(key) > 1024 || !utf8.ValidString(key) {
		return "", errors.New("invalid storage key")
	}
	return filepath.Join(directory, storageDigest(key)+".dat"), nil
}

func (s *applicationStorage) read(namespace, key string) (*StorageValue, error) {
	path, err := s.path(namespace, key)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > applicationStorageValueLimit+4096 {
		return nil, errors.New("invalid storage record")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	headerData, body, found := bytes.Cut(data, []byte{'\n'})
	var header storageHeader
	if !found || len(headerData) > 4096 || json.Unmarshal(headerData, &header) != nil ||
		header.Version != 1 || header.Key != key || len(body) > applicationStorageValueLimit {
		return nil, errors.New("damaged application storage record")
	}
	value := &StorageValue{Kind: header.Kind, MediaType: header.MediaType}
	switch header.Kind {
	case "text", "json":
		if !utf8.Valid(body) || (header.Kind == "json" && !json.Valid(body)) {
			return nil, errors.New("damaged application storage payload")
		}
		value.Value = string(body)
	case "blob", "arraybuffer":
		value.Value = base64.StdEncoding.EncodeToString(body)
	default:
		return nil, errors.New("unknown application storage encoding")
	}
	return value, nil
}

func (s *applicationStorage) write(namespace, key string, value StorageValue) error {
	path, err := s.path(namespace, key)
	if err != nil {
		return err
	}
	// Preserve a damaged previous value until an explicit reset/removal. A failed
	// read must never be silently converted into an empty/default overwrite.
	if _, err := s.read(namespace, key); err != nil {
		return err
	}
	body := []byte(value.Value)
	switch value.Kind {
	case "text":
		if namespace != "renderer" || !utf8.Valid(body) {
			return errors.New("invalid text storage value")
		}
	case "json":
		if !json.Valid(body) {
			return errors.New("invalid JSON storage value")
		}
	case "blob", "arraybuffer":
		if len(body) > base64.StdEncoding.EncodedLen(applicationStorageValueLimit) {
			return errors.New("storage value too large")
		}
		body, err = base64.StdEncoding.DecodeString(value.Value)
		if err != nil {
			return errors.New("invalid binary storage value")
		}
	default:
		return errors.New("unknown storage encoding")
	}
	if len(body) > applicationStorageValueLimit || len(value.MediaType) > 255 {
		return errors.New("storage value too large")
	}
	header, err := json.Marshal(storageHeader{Version: 1, Key: key, Kind: value.Kind, MediaType: value.MediaType})
	if err != nil {
		return err
	}
	if len(header) > 4096 {
		return errors.New("storage key header too large")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if err = writeSettingsOutput(file, append(append(header, '\n'), body...)); err != nil {
		return err
	}
	return commitPreferencesResetRename(file.Name(), path)
}

func (s *applicationStorage) keys(namespace string) ([]string, error) {
	directory, err := s.directory(namespace)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	keys := []string{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".dat") {
			continue
		}
		if !entry.Type().IsRegular() {
			return nil, errors.New("invalid storage entry")
		}
		file, err := os.Open(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		headerData, err := io.ReadAll(io.LimitReader(file, 4097))
		file.Close()
		headerData, _, found := bytes.Cut(headerData, []byte{'\n'})
		var header storageHeader
		if err != nil || !found || len(headerData) > 4096 || json.Unmarshal(headerData, &header) != nil ||
			header.Version != 1 || storageDigest(header.Key)+".dat" != entry.Name() {
			return nil, errors.New("damaged storage index")
		}
		keys = append(keys, header.Key)
	}
	return keys, nil
}

func storageCall(ctx context.Context, fn func() error) error {
	// Bound methods run on worker goroutines. Validate on the main thread, then
	// keep disk IO and recovery on the worker under the storage mutex.
	if err := desktopLifecycle.call(ctx, false, func() error { return nil }); err != nil {
		return err
	}
	return businessStorage.withContext(ctx, fn)
}

func (s *applicationStorage) withContext(ctx context.Context, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if s.frozen == ctx {
		return errors.New("application data replaced; reload required")
	}
	if s.recoveryRequired {
		if err := recoverApplicationStorageImport(s.root); err != nil {
			return err
		}
		s.recoveryRequired = false
	}
	return fn()
}

func (*DesktopStorage) LocalSnapshot(ctx context.Context) (map[string]string, error) {
	values := map[string]string{}
	err := storageCall(ctx, func() error {
		keys, err := businessStorage.keys("renderer")
		if err != nil {
			return err
		}
		for _, key := range keys {
			value, err := businessStorage.read("renderer", key)
			if err != nil {
				return err
			}
			if value == nil || value.Kind != "text" {
				return errors.New("invalid renderer storage record")
			}
			values[key] = value.Value
		}
		return nil
	})
	return values, err
}

func (*DesktopStorage) Get(ctx context.Context, namespace, key string) (*StorageValue, error) {
	var value *StorageValue
	err := storageCall(ctx, func() error {
		var err error
		value, err = businessStorage.read(namespace, key)
		return err
	})
	return value, err
}

func (*DesktopStorage) Put(ctx context.Context, namespace, key string, value StorageValue) error {
	return storageCall(ctx, func() error { return businessStorage.write(namespace, key, value) })
}

func (*DesktopStorage) Remove(ctx context.Context, namespace, key string) error {
	return storageCall(ctx, func() error {
		path, err := businessStorage.path(namespace, key)
		if err != nil {
			return err
		}
		return removePreferencesResetFile(path)
	})
}

func (*DesktopStorage) Keys(ctx context.Context, namespace string) ([]string, error) {
	var keys []string
	err := storageCall(ctx, func() error {
		var err error
		keys, err = businessStorage.keys(namespace)
		return err
	})
	return keys, err
}

func (*DesktopStorage) Clear(ctx context.Context, namespace string) error {
	return storageCall(ctx, func() error { return businessStorage.clear(namespace) })
}

func (s *applicationStorage) clear(namespace string) error {
	directory, err := s.directory(namespace)
	if err != nil {
		return err
	}
	// Only an application-owned hashed directory is removed, never a renderer path.
	return os.RemoveAll(directory)
}

func resetApplicationStorage(directory string, mode PreferencesResetMode) error {
	root := filepath.Join(directory, applicationStorageDirectory)
	if mode == PreferencesResetAll {
		return errors.Join(os.RemoveAll(root), os.RemoveAll(root+".import"), os.RemoveAll(root+".previous"))
	}
	if err := recoverApplicationStorageImport(root); err != nil {
		return err
	}
	store := applicationStorage{root: root}
	for _, key := range []string{"setting-store", "native-window-appearance"} {
		path, err := store.path("renderer", key)
		if err != nil {
			return err
		}
		if err := removePreferencesResetFile(path); err != nil {
			return err
		}
	}
	return nil
}
