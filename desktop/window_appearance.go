package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

const (
	windowAppearanceVersion = 1
	windowAppearanceMaxSize = 4096
)

type WindowAppearance struct {
	UseBorderless bool `json:"useBorderless"`
}

type WindowAppearanceReceipt struct {
	Applied         bool `json:"applied"`
	Pending         bool `json:"pending"`
	RestartRequired bool `json:"restartRequired"`
}

type WindowAppearanceError struct {
	Code string
}

func (e *WindowAppearanceError) Error() string { return "window appearance " + e.Code }

type windowAppearanceFile struct {
	Version       int  `json:"version"`
	UseBorderless bool `json:"useBorderless"`
}

type WindowAppearanceStore struct {
	path string
}

func NewWindowAppearanceStore(path string) (*WindowAppearanceStore, error) {
	if path == "" {
		return nil, &WindowAppearanceError{Code: "invalid_path"}
	}
	return &WindowAppearanceStore{path: path}, nil
}

func (s *WindowAppearanceStore) Load() (WindowAppearance, WindowAppearanceReceipt, error) {
	fallback := WindowAppearance{}
	input, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return fallback, WindowAppearanceReceipt{}, nil
	}
	if err != nil {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "read_failed"}
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, windowAppearanceMaxSize+1))
	if err != nil {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "read_failed"}
	}
	if len(data) == 0 || len(data) > windowAppearanceMaxSize {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_size"}
	}
	if validateSettingsJSON(data, true) != nil {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_format"}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != 2 {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_format"}
	}
	if _, ok := fields["version"]; !ok {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "unsupported_version"}
	}
	borderless, ok := fields["useBorderless"]
	if !ok || (!bytes.Equal(borderless, []byte("true")) && !bytes.Equal(borderless, []byte("false"))) {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_format"}
	}
	var file windowAppearanceFile
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_format"}
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "invalid_format"}
	}
	if file.Version != windowAppearanceVersion {
		return fallback, WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "unsupported_version"}
	}
	return WindowAppearance{UseBorderless: file.UseBorderless}, WindowAppearanceReceipt{Applied: true}, nil
}

func (s *WindowAppearanceStore) Save(appearance WindowAppearance) (WindowAppearanceReceipt, error) {
	file := windowAppearanceFile{Version: windowAppearanceVersion, UseBorderless: appearance.UseBorderless}
	data, err := json.Marshal(file)
	if err != nil {
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "encode_failed"}
	}
	parent := filepath.Dir(s.path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "directory_failed"}
	}
	tmp, err := os.CreateTemp(parent, ".window-appearance-*")
	if err != nil {
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "write_failed"}
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "write_failed"}
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "write_failed"}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "write_failed"}
	}
	if err := tmp.Close(); err != nil {
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "write_failed"}
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return WindowAppearanceReceipt{}, &WindowAppearanceError{Code: "commit_failed"}
	}
	return WindowAppearanceReceipt{Pending: true, RestartRequired: true}, nil
}

// WindowAppearanceOptions maps persisted appearance to the next startup window.
func WindowAppearanceOptions(appearance WindowAppearance) mygo.WindowOptions {
	return mygo.WindowOptions{Frameless: appearance.UseBorderless}
}
