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

	"github.com/egoist/mygo"
)

const linuxGraphicsFile = "linux-graphics.json"

// This preference belongs to this machine, outside portable application backups.
type LinuxGraphicsState struct {
	Enabled         bool `json:"enabled"`
	Applied         bool `json:"applied"`
	RestartRequired bool `json:"restartRequired"`
	LoadFailed      bool `json:"loadFailed"`
}

type LinuxGraphics struct {
	mu        sync.Mutex
	directory string
	desired   bool
	applied   bool
	failed    bool
}

var desktopLinuxGraphics = &LinuxGraphics{}

func init() { mygo.Bind(desktopLinuxGraphics) }

func loadLinuxGraphics(directory string) (enabled, found bool, err error) {
	path := filepath.Join(directory, linuxGraphicsFile)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return false, true, errors.New("invalid graphics preference file")
	}
	input, err := os.Open(path)
	if err != nil {
		return false, true, err
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, 4097))
	if err != nil {
		return false, true, err
	}
	if len(data) > 4096 || validateSettingsJSON(data, true) != nil {
		return false, true, errors.New("invalid graphics preference")
	}
	var value struct {
		Version int   `json:"version"`
		Enabled *bool `json:"enabled"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF || value.Version != 1 || value.Enabled == nil {
		return false, true, errors.New("invalid graphics preference")
	}
	return *value.Enabled, true, nil
}

func saveLinuxGraphics(directory string, enabled bool) error {
	if directory == "" || !filepath.IsAbs(directory) {
		return errors.New("graphics preference directory unavailable")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		Version int  `json:"version"`
		Enabled bool `json:"enabled"`
	}{1, enabled})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".linux-graphics-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if err := writeSettingsOutput(file, data); err != nil {
		return err
	}
	return commitPreferencesResetRename(file.Name(), filepath.Join(directory, linuxGraphicsFile))
}

func (s *LinuxGraphics) snapshot() LinuxGraphicsState {
	return LinuxGraphicsState{Enabled: s.desired, Applied: s.applied, RestartRequired: s.desired != s.applied, LoadFailed: s.failed}
}

func (s *LinuxGraphics) Current(ctx context.Context) (LinuxGraphicsState, error) {
	var state LinuxGraphicsState
	if err := desktopLifecycle.call(ctx, true, func() error { return nil }); err != nil {
		return state, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.directory == "" {
		return state, errors.New("linux graphics settings unavailable")
	}
	return s.snapshot(), nil
}

func (s *LinuxGraphics) Save(ctx context.Context, enabled bool) (LinuxGraphicsState, error) {
	var state LinuxGraphicsState
	if err := desktopLifecycle.call(ctx, true, func() error { return nil }); err != nil {
		return state, err
	}
	err := businessStorage.withContext(ctx, func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.directory == "" {
			return errors.New("linux graphics settings unavailable")
		}
		if err := saveLinuxGraphics(s.directory, enabled); err != nil {
			return err
		}
		s.desired, s.failed = enabled, false
		state = s.snapshot()
		return nil
	})
	return state, err
}

var linuxGraphicsEnvironment = []struct{ key, value string }{
	{"LIBGL_ALWAYS_SOFTWARE", "1"},
	{"WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1"},
	{"WEBKIT_DISABLE_DMABUF_RENDERER", "0"},
	{"WEBKIT_DISABLE_COMPOSITING_MODE", "0"},
}

// Build the child's initial environment; Go-only Setenv cannot be relied on to
// update a dynamically loaded C library's getenv view in a CGO_ENABLED=0 app.
func linuxGraphicsLaunchEnvironment(environment []string, enabled bool) ([]string, bool) {
	next := make([]string, 0, len(environment)+4)
	current := make(map[string]string)
	counts := make(map[string]int)
	for _, entry := range environment {
		owned := false
		for _, flag := range linuxGraphicsEnvironment {
			if len(entry) >= len(flag.key)+1 && entry[:len(flag.key)+1] == flag.key+"=" {
				current[flag.key] = entry[len(flag.key)+1:]
				counts[flag.key]++
				owned = true
				break
			}
		}
		if !owned {
			next = append(next, entry)
		}
	}
	changed := false
	for _, flag := range linuxGraphicsEnvironment {
		value, exists := current[flag.key]
		if enabled {
			next = append(next, flag.key+"="+flag.value)
			changed = changed || !exists || counts[flag.key] != 1 || value != flag.value
		} else {
			changed = changed || exists
		}
	}
	return next, changed
}

func linuxGraphicsApplied(environment []string) bool {
	_, changed := linuxGraphicsLaunchEnvironment(environment, true)
	return !changed
}

// prepare only reads startup intent; reset deletion remains under the existing
// single-instance startup transaction. An explicit diagnostic override is local
// to that launch and never changes the saved preference.
func (s *LinuxGraphics) prepare(directory string, environment []string) ([]string, bool, error) {
	tx, err := readPreferencesReset(directory)
	if err != nil {
		return nil, false, err
	}
	desired, found, loadErr := loadLinuxGraphics(directory)
	requested, controlled := desired, found && loadErr == nil
	for _, entry := range environment {
		switch entry {
		case "HE_MUSIC_GRAPHICS_MODE_OVERRIDE=software-gl":
			requested, controlled = true, true
		case "HE_MUSIC_GRAPHICS_MODE_OVERRIDE=normal":
			requested, controlled = false, true
		}
	}
	if tx.TransactionID != "" {
		desired, requested, controlled, loadErr = false, false, true, nil
	}
	s.directory, s.desired, s.failed = directory, desired, loadErr != nil
	s.applied = linuxGraphicsApplied(environment)
	if !controlled {
		return environment, false, nil
	}
	next, changed := linuxGraphicsLaunchEnvironment(environment, requested)
	return next, changed, nil
}
