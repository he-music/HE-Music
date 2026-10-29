package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/egoist/mygo"
)

var errLibraryPersistence = errors.New("local directory persistence unavailable or invalid")

type libraryDirectoryDocument struct {
	Version     int      `json:"version"`
	Directories []string `json:"directories"`
}

type libraryDirectoryStore struct {
	mu   sync.Mutex
	path string
}

var savedLibraryDirectories libraryDirectoryStore

// The caller supplies the already resolved private AppUserData directory at startup.
// Configuration alone performs no IO, including during binding generation.
func prepareLibraryPersistence(directory string) error {
	if !filepath.IsAbs(directory) {
		return errLibraryPersistence
	}
	savedLibraryDirectories.mu.Lock()
	defer savedLibraryDirectories.mu.Unlock()
	savedLibraryDirectories.path = filepath.Join(directory, "local-library-directories.json")
	return nil
}

// Only successful native picker selections may call this helper. Renderer paths
// must never reach it: remembering a path authorizes future non-sandbox restoration.
func libraryRememberDirectory(displayPath string) error {
	return savedLibraryDirectories.update(displayPath, true)
}

func libraryForgetDirectory(displayPath string) error {
	return savedLibraryDirectories.update(displayPath, false)
}

func validLibraryPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path
}

// Caller holds mu. Refuse malformed documents rather than replacing them with an
// empty library on the next successful selection.
func (store *libraryDirectoryStore) load() ([]string, error) {
	if store.path == "" || os.Getenv("MYGO_GENERATE") != "" {
		return nil, errLibraryPersistence
	}
	before, err := os.Lstat(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil || !before.Mode().IsRegular() || before.Size() > settingsMaxBytes {
		return nil, errLibraryPersistence
	}
	file, err := os.OpenFile(store.path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errLibraryPersistence
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, errLibraryPersistence
	}
	data, err := io.ReadAll(io.LimitReader(file, settingsMaxBytes+1))
	if err != nil || validateSettingsJSON(data, true) != nil {
		return nil, errLibraryPersistence
	}
	var document libraryDirectoryDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || document.Version != 1 || document.Directories == nil || len(document.Directories) > 32 {
		return nil, errLibraryPersistence
	}
	seen := make(map[string]bool)
	for _, path := range document.Directories {
		if !validLibraryPath(path) || seen[path] {
			return nil, errLibraryPersistence
		}
		seen[path] = true
	}
	return document.Directories, nil
}

func (store *libraryDirectoryStore) snapshot() ([]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.load()
}

func libraryPathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && filepath.IsLocal(relative)
}

func (store *libraryDirectoryStore) update(path string, remember bool) error {
	if !validLibraryPath(path) {
		return errLibraryPersistence
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	paths, err := store.load()
	if err != nil {
		return err
	}
	result := make([]string, 0, len(paths)+1)
	for _, existing := range paths {
		if remember && libraryPathContains(existing, path) {
			return nil
		}
		if existing == path || (remember && libraryPathContains(path, existing)) {
			continue
		}
		result = append(result, existing)
	}
	if remember {
		result = append(result, path)
	}
	if len(result) > 32 {
		return errLibraryPersistence
	}
	data, err := json.Marshal(libraryDirectoryDocument{Version: 1, Directories: result})
	if err != nil || len(data) > settingsMaxBytes {
		return errLibraryPersistence
	}
	// Reuse the confined atomic replace used by settings exports. Its temporary
	// file is created exclusively with 0600, synced, closed, then renamed.
	save, err := prepareSettingsSave(store.path, data)
	if err != nil {
		return errLibraryPersistence
	}
	defer save.cleanup()
	if save.replace() != nil {
		return errLibraryPersistence
	}
	return nil
}

type RestoredDirectories struct {
	Grants      []DirectoryGrant `json:"grants"`
	Unavailable []string         `json:"unavailable"`
}

func (f *NativeFiles) RestoreDirectories(ctx context.Context, epoch uint64) (RestoredDirectories, error) {
	return f.state.restoreDirectories(ctx, epoch, &savedLibraryDirectories)
}

// ForgetSavedDirectory only removes an existing persisted record, including a
// missing directory. It never opens a renderer-supplied path or grants access.
func (f *NativeFiles) ForgetSavedDirectory(ctx context.Context, epoch uint64, displayPath string) error {
	return f.state.forgetSavedDirectory(ctx, epoch, displayPath, &savedLibraryDirectories)
}

func (s *nativeFilesState) forgetSavedDirectory(ctx context.Context, epoch uint64, path string, store *libraryDirectoryStore) error {
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return err
	}
	defer s.finish(op)
	// Claim before the atomic disk update, using the same cancellation boundary
	// as settings export. No grant is created or revoked by this operation.
	if err := s.claimCommit(op); err != nil {
		return err
	}
	return store.update(path, false)
}

func (s *nativeFilesState) restoreDirectories(ctx context.Context, epoch uint64, store *libraryDirectoryStore) (RestoredDirectories, error) {
	result := RestoredDirectories{Grants: []DirectoryGrant{}, Unavailable: []string{}}
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return result, err
	}
	defer s.finish(op)
	paths, err := store.snapshot()
	if err != nil {
		return result, err
	}
	seen := make(map[string]bool)
	for _, path := range paths {
		if err := s.check(op); err != nil {
			return result, err
		}
		grant, unavailable, err := s.restoreDirectory(op, path)
		if err != nil {
			return result, err
		}
		if unavailable {
			result.Unavailable = append(result.Unavailable, path)
		} else if !seen[grant.Token] {
			seen[grant.Token] = true
			result.Grants = append(result.Grants, grant)
		}
	}
	return result, s.check(op)
}

func (s *nativeFilesState) restoreDirectory(op *fileOperation, path string) (DirectoryGrant, bool, error) {
	var grant DirectoryGrant
	// Root opening, identity capture and overlap computation stay off the actor.
	handle, err := openDirectoryHandle(path)
	if err != nil {
		return grant, true, s.check(op)
	}
	accepted := false
	defer func() {
		if !accepted {
			_ = handle.root.Close()
		}
	}()
	token, err := newDirectoryToken()
	if err != nil {
		return grant, false, err
	}
	overlaps, err := s.directoryOverlaps(op, handle)
	if err != nil {
		return grant, false, err
	}
	err = s.main(op.owner, func(parent *mygo.Window) error {
		if !s.owns(op.owner, op.epoch) || s.busy != op || parent != op.parent || op.phase.Load() != fileOpActive {
			return errFilesOwner
		}
		for _, overlap := range overlaps {
			if entry, exists := s.grants[overlap.token]; exists && entry.handle == overlap.handle {
				grant = entry.grant
				return nil
			}
		}
		if len(s.grants) >= 32 {
			return errDirectory
		}
		grant = DirectoryGrant{Token: token, DisplayPath: handle.canonical, Epoch: op.epoch}
		if s.grants == nil {
			s.grants = make(map[string]ownedDirectory)
		}
		s.grants[token] = ownedDirectory{grant: grant, handle: handle}
		accepted = true
		return nil
	})
	return grant, false, err
}
