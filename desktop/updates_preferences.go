package main

import (
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"

	"github.com/egoist/mygo/plugins/updater"
)

// The plugin has no public setter for skipped versions. Seed its documented
// preferences once, before its first load, without replacing existing choices.
func migrateUpdaterPreferences(directory string, legacy *StorageValue) error {
	filename := filepath.Join(directory, "updater.json")
	if info, err := os.Lstat(filename); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("invalid updater preferences file")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	previous := struct {
		AutomaticChecks *bool  `json:"checkUpdateOnStart"`
		SkippedVersion  string `json:"skippedUpdateVersion"`
	}{AutomaticChecks: new(true)}
	if legacy != nil {
		if err := json.Unmarshal([]byte(legacy.Value), &previous); err != nil {
			return err
		}
	}
	preferences := struct {
		AutomaticChecks *bool  `json:"automaticChecks"`
		SkippedVersion  string `json:"skippedVersion,omitempty"`
	}{previous.AutomaticChecks, previous.SkippedVersion}
	data, err := json.Marshal(preferences)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(filename)
	}
	return err
}

func prepareUpdaterPreferences(directory string) error {
	businessStorage.mu.Lock()
	legacy, err := businessStorage.read("renderer", "setting-store")
	businessStorage.mu.Unlock()
	if err != nil {
		return err
	}
	return migrateUpdaterPreferences(directory, legacy)
}

func prepareApplicationStorageAndUpdates(directory string) error {
	if err := prepareApplicationStorage(directory); err != nil {
		return err
	}
	if err := prepareUpdaterPreferences(directory); err != nil {
		return err
	}
	// The renderer setting is authoritative. Wait for its ready session before
	// scheduling, including when a previous updater.json enabled checks.
	if desktopUpdates.configured {
		updater.SetAutomaticChecks(false)
	}
	return nil
}
