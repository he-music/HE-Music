package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWindowAppearanceDefaultAndStartupMapping(t *testing.T) {
	dir := t.TempDir()
	store, err := NewWindowAppearanceStore(filepath.Join(dir, "appearance.json"))
	if err != nil {
		t.Fatal(err)
	}
	appearance, receipt, err := store.Load()
	if err != nil || appearance.UseBorderless || receipt != (WindowAppearanceReceipt{}) {
		t.Fatalf("default load = %#v, %#v, %v", appearance, receipt, err)
	}
	pending, err := store.Save(WindowAppearance{UseBorderless: true})
	if err != nil || pending.Applied || !pending.Pending || !pending.RestartRequired {
		t.Fatalf("save receipt = %#v, %v", pending, err)
	}
	loaded, applied, err := store.Load()
	if err != nil || !loaded.UseBorderless || !applied.Applied || applied.Pending || applied.RestartRequired {
		t.Fatalf("startup load = %#v, %#v, %v", loaded, applied, err)
	}
	if options := WindowAppearanceOptions(loaded); options.Frameless != (runtime.GOOS != "darwin") {
		t.Fatalf("startup options did not map frameless: %#v", options)
	}
}

func TestWindowAppearanceRejectsInvalidAndUnknownFiles(t *testing.T) {
	cases := []struct {
		name string
		data string
		code string
	}{
		{name: "missing version", data: `{"useBorderless":true}`, code: "invalid_format"},
		{name: "wrong bool", data: `{"version":1,"useBorderless":"true"}`, code: "invalid_format"},
		{name: "unknown field", data: `{"version":1,"useBorderless":false,"extra":1}`, code: "invalid_format"},
		{name: "unknown version", data: `{"version":2,"useBorderless":false}`, code: "unsupported_version"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "appearance.json")
			if err := os.WriteFile(path, []byte(test.data), 0o600); err != nil {
				t.Fatal(err)
			}
			store, err := NewWindowAppearanceStore(path)
			if err != nil {
				t.Fatal(err)
			}
			appearance, receipt, err := store.Load()
			if appearance.UseBorderless || receipt != (WindowAppearanceReceipt{}) {
				t.Fatalf("invalid config was applied: %#v, %#v", appearance, receipt)
			}
			if err == nil || !strings.Contains(err.Error(), test.code) {
				t.Fatalf("error = %v, want %s", err, test.code)
			}
		})
	}
}

func TestWindowAppearanceSaveFailurePreservesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "appearance.json")
	store, err := NewWindowAppearanceStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(WindowAppearance{UseBorderless: false}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := NewWindowAppearanceStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failed.Save(WindowAppearance{UseBorderless: true}); err == nil {
		t.Fatal("expected save failure")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("failed save changed existing file: %q -> %q", before, after)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "appearance.json" {
		t.Fatalf("temporary file remained: %#v", entries)
	}
}
