package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdaterMigratesLegacyChoicesWithoutOverwritingPluginPreferences(t *testing.T) {
	directory := t.TempDir()
	legacy := &StorageValue{Value: `{"checkUpdateOnStart":false,"skippedUpdateVersion":"2.0.4"}`}
	if err := migrateUpdaterPreferences(directory, legacy); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(directory, "updater.json")
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		AutomaticChecks bool   `json:"automaticChecks"`
		SkippedVersion  string `json:"skippedVersion"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if state.AutomaticChecks || state.SkippedVersion != "2.0.4" {
		t.Fatal(state)
	}
	existing := `{"automaticChecks":true,"automaticDownloads":true,"skippedVersion":"2.0.5"}`
	if err := os.WriteFile(filename, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := migrateUpdaterPreferences(directory, legacy); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(filename)
	if err != nil || string(data) != existing {
		t.Fatalf("plugin choices changed: %s, %v", data, err)
	}
}

func TestUpdaterMigrationDefaultsAndInvalidLegacyState(t *testing.T) {
	for _, legacy := range []*StorageValue{nil, {Value: `{}`}} {
		directory := t.TempDir()
		if err := migrateUpdaterPreferences(directory, legacy); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(directory, "updater.json"))
		if err != nil || string(data) != `{"automaticChecks":true}` {
			t.Fatalf("unexpected default: %s, %v", data, err)
		}
	}
	for _, value := range []string{`broken`, `{"checkUpdateOnStart":"false"}`} {
		directory := t.TempDir()
		if err := migrateUpdaterPreferences(directory, &StorageValue{Value: value}); err == nil {
			t.Fatal("invalid legacy preferences accepted")
		}
		if _, err := os.Lstat(filepath.Join(directory, "updater.json")); !os.IsNotExist(err) {
			t.Fatal("invalid migration left a preferences file")
		}
	}
}

func TestUpdaterMigrationRejectsSpecialPreferencesFiles(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "updater.json")
	if err := os.Mkdir(filename, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := migrateUpdaterPreferences(directory, nil); err == nil {
		t.Fatal("a directory was accepted as updater preferences")
	}
}

func TestQuitSaveGuardPreservesResultAndRejectsReentrantQuit(t *testing.T) {
	var guard quitSaveGuard
	for _, want := range []bool{false, true} {
		if got := guard.prepare(func() bool {
			if guard.prepare(func() bool { t.Fatal("reentrant save ran"); return true }) {
				t.Fatal("reentrant quit was allowed")
			}
			return want
		}); got != want || guard.running {
			t.Fatal("save result or guard cleanup was lost")
		}
	}
}
