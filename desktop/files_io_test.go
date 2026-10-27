package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeFileTestDirectory(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
}

func writeFileTestSettings(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func assertNoSettingsTemp(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".he-music-settings-") {
			t.Fatal("temporary settings file leaked")
		}
	}
}

func TestDirectoryHandlesCanonicalRelationsAndConfinement(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "music")
	childPath := filepath.Join(rootPath, "child")
	siblingPath := filepath.Join(base, "music-other")
	makeFileTestDirectory(t, childPath)
	makeFileTestDirectory(t, siblingPath)
	link := filepath.Join(base, "alias")
	if err := os.Symlink(rootPath, link); err != nil {
		t.Fatal(err)
	}
	root, err := openDirectoryHandle(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.root.Close()
	for _, test := range []struct{ path, relation string }{{link, "duplicate"}, {childPath, "child"}, {base, "parent"}, {siblingPath, ""}} {
		candidate, err := openDirectoryHandle(test.path)
		if err != nil {
			t.Fatal(err)
		}
		if got := directoryIdentityRelation(root, candidate); string(got) != test.relation {
			t.Errorf("relation = %q, want %q", got, test.relation)
		}
		if test.path == link && candidate.canonical != root.canonical {
			t.Error("symlink not canonical")
		}
		candidate.root.Close()
	}
	outside := filepath.Join(base, "outside.json")
	writeFileTestSettings(t, outside, []byte(`{}`))
	if err := os.Symlink(outside, filepath.Join(rootPath, "escape.json")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside.json", "escape.json"} {
		file, err := root.root.Open(name)
		if err == nil {
			file.Close()
			t.Fatal("root escape accepted")
		}
	}
	if err := root.root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := root.root.Stat("."); !errors.Is(err, os.ErrClosed) {
		t.Fatal("closed handle remains usable")
	}
	if _, err := openDirectoryHandle("relative"); err == nil {
		t.Fatal("relative directory accepted")
	}
	if _, err := openDirectoryHandle(outside); err == nil {
		t.Fatal("file accepted as directory")
	}
}

func TestSelectedSettingsReadRejectsSpecialAndOversizedFiles(t *testing.T) {
	dir := t.TempDir()
	good, err := encodeRendererSettings(validRendererSettings())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	writeFileTestSettings(t, path, good)
	if _, err := readSelectedSettings(path); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(dir, "directory.json")
	makeFileTestDirectory(t, folder)
	fifo := filepath.Join(dir, "fifo.json")
	t.Run("FIFO", func(t *testing.T) {
		if err := makeFileTestFIFO(fifo); err != nil {
			if errors.Is(err, errFileTestFIFOUnsupported) {
				t.Skip("FIFO is unsupported on this platform")
			}
			t.Fatal(err)
		}
		if _, err := readSelectedSettings(fifo); err == nil {
			t.Fatal("FIFO accepted")
		}
	})
	huge := filepath.Join(dir, "huge.json")
	writeFileTestSettings(t, huge, []byte(strings.Repeat("x", settingsMaxBytes+1)))
	corrupt := filepath.Join(dir, "corrupt.json")
	writeFileTestSettings(t, corrupt, []byte(`{`))
	wrong := filepath.Join(dir, "settings.txt")
	writeFileTestSettings(t, wrong, good)
	for _, input := range []string{link, folder, huge, corrupt, wrong} {
		if _, err := readSelectedSettings(input); err == nil {
			t.Error("invalid selected file accepted")
		}
	}
}

func TestPreparedSettingsSaveAtomicReplaceAndFailureCleanup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	original := []byte(`{"old":true}`)
	data, err := encodeRendererSettings(validRendererSettings())
	if err != nil {
		t.Fatal(err)
	}
	writeFileTestSettings(t, path, original)
	save, err := prepareSettingsSave(path, data)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil || string(before) != string(original) {
		t.Fatal("prepare changed original")
	}
	if err := save.replace(); err != nil {
		t.Fatal(err)
	}
	save.cleanup()
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != string(data) {
		t.Fatal("replace did not publish full document")
	}
	assertNoSettingsTemp(t, dir)
	// Remove the prepared source to induce an actual rename failure. No truncate or
	// copy fallback may touch the original destination.
	save, err = prepareSettingsSave(path, []byte(`{"new":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := save.parent.root.Remove(save.temp); err != nil {
		t.Fatal(err)
	}
	if err := save.replace(); err == nil {
		t.Fatal("rename failure not reported")
	}
	save.cleanup()
	actual, err = os.ReadFile(path)
	if err != nil || string(actual) != string(data) {
		t.Fatal("failed replace damaged original")
	}
	assertNoSettingsTemp(t, dir)
	// An entry replaced after preparation must be rejected before commit.
	save, err = prepareSettingsSave(path, original)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere.json", path); err != nil {
		t.Fatal(err)
	}
	if err := save.replace(); err == nil {
		t.Fatal("substituted symlink accepted")
	}
	save.cleanup()
	assertNoSettingsTemp(t, dir)
	if _, err := prepareSettingsSave(path, data); err == nil {
		t.Fatal("symlink save target accepted")
	}
	folder := filepath.Join(dir, "folder.json")
	makeFileTestDirectory(t, folder)
	if _, err := prepareSettingsSave(folder, data); err == nil {
		t.Fatal("directory save target accepted")
	}
	assertNoSettingsTemp(t, dir)
}

func TestPreparedSettingsSavePinsParentDirectory(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "selected")
	makeFileTestDirectory(t, dir)
	save, err := prepareSettingsSave(filepath.Join(dir, "new.json"), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer save.cleanup()
	moved := filepath.Join(base, "moved")
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	makeFileTestDirectory(t, dir)
	if err := save.replace(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("write followed replacement parent path")
	}
	if _, err := os.Stat(filepath.Join(moved, "new.json")); err != nil {
		t.Fatal(err)
	}
}
