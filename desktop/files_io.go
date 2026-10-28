package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
)

var errFileIO = errors.New("settings file operation failed")
var errDirectory = errors.New("directory selection unavailable")

type directoryHandle struct {
	root         *os.Root
	canonical    string
	info         os.FileInfo
	ancestors    []os.FileInfo
	leaseContext context.Context
	leaseCancel  context.CancelFunc
	leaseCount   atomic.Int64
	retired      atomic.Bool
	closed       atomic.Bool
	filePaths    map[string]string
}

func openDirectoryHandle(path string) (*directoryHandle, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errDirectory
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return nil, errDirectory
	}
	before, err := os.Stat(canonical)
	if err != nil || !before.IsDir() {
		return nil, errDirectory
	}
	root, err := os.OpenRoot(canonical)
	if err != nil {
		return nil, errDirectory
	}
	after, err := root.Stat(".")
	current, currentErr := os.Stat(canonical)
	if err != nil || currentErr != nil || !os.SameFile(before, after) || !os.SameFile(current, after) {
		root.Close()
		return nil, errDirectory
	}
	ancestors, err := directoryAncestorIdentities(canonical)
	if err != nil {
		root.Close()
		return nil, errDirectory
	}
	return &directoryHandle{root: root, canonical: canonical, info: after, ancestors: ancestors}, nil
}

func newDirectoryToken() (string, error) {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", errDirectory
	}
	return hex.EncodeToString(bytes[:]), nil
}

// Only a picker-returned path reaches this helper. Pin the parent directory and
// address exactly one basename through Root, never through renderer input.
func openSettingsParent(path string) (*directoryHandle, string, error) {
	if !filepath.IsAbs(path) || strings.ToLower(filepath.Ext(path)) != ".json" {
		return nil, "", errFileIO
	}
	parent, err := openDirectoryHandle(filepath.Dir(path))
	if err != nil {
		return nil, "", errFileIO
	}
	return parent, filepath.Base(path), nil
}

func readSelectedSettings(path string) (RendererSettingsDocument, error) {
	var empty RendererSettingsDocument
	parent, name, err := openSettingsParent(path)
	if err != nil {
		return empty, err
	}
	defer parent.root.Close()
	before, err := parent.root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Size() > settingsMaxBytes {
		return empty, errFileIO
	}
	// Nonblocking open prevents a concurrent FIFO substitution from hanging. Root
	// confines symlink resolution; handle identity/type is checked before any read.
	file, err := parent.root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return empty, errFileIO
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() > settingsMaxBytes {
		return empty, errFileIO
	}
	data, err := io.ReadAll(io.LimitReader(file, settingsMaxBytes+1))
	if err != nil || len(data) > settingsMaxBytes {
		return empty, errFileIO
	}
	return decodeRendererSettings(data)
}

type preparedSettingsSave struct {
	parent   *directoryHandle
	name     string
	temp     string
	original os.FileInfo
}

func prepareSettingsSave(path string, data []byte) (*preparedSettingsSave, error) {
	parent, name, err := openSettingsParent(path)
	if err != nil {
		return nil, err
	}
	save := &preparedSettingsSave{parent: parent, name: name}
	ok := false
	defer func() {
		if !ok {
			save.cleanup()
		}
	}()
	original, err := parent.root.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errFileIO
	}
	if err == nil && !original.Mode().IsRegular() {
		return nil, errFileIO
	}
	save.original = original
	token, err := newDirectoryToken()
	if err != nil {
		return nil, errFileIO
	}
	save.temp = ".he-music-settings-" + token + ".tmp"
	file, err := parent.root.OpenFile(save.temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errFileIO
	}
	if err := writeSettingsOutput(file, data); err != nil {
		return nil, errFileIO
	}
	ok = true
	return save, nil
}

// Rename replaces a directory entry, never follows a target symlink, and has no
// truncate/copy fallback. Parent handle confinement survives parent path renames.
// This is atomic visibility, not crash durability of the containing directory.
func (save *preparedSettingsSave) replace() error {
	current, err := save.parent.root.Lstat(save.name)
	if save.original == nil {
		if !errors.Is(err, os.ErrNotExist) {
			return errFileIO
		}
	} else if err != nil || !current.Mode().IsRegular() || !os.SameFile(save.original, current) {
		return errFileIO
	}
	if err := save.parent.root.Rename(save.temp, save.name); err != nil {
		return errFileIO
	}
	save.temp = ""
	return nil
}

func (save *preparedSettingsSave) cleanup() {
	if save.temp != "" {
		_ = save.parent.root.Remove(save.temp)
	}
	_ = save.parent.root.Close()
}
