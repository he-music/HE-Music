package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	"github.com/egoist/mygo"
)

const (
	applicationBackupFormat = "he-music-application-data"
	applicationBackupLimit  = 128 << 20
)

type ApplicationStorageRecord struct {
	Namespace string       `json:"namespace"`
	Key       string       `json:"key"`
	Data      StorageValue `json:"data"`
}

type ApplicationBackup struct {
	Format  string                     `json:"format"`
	Version int                        `json:"version"`
	Records []ApplicationStorageRecord `json:"records"`
}

// A complete validated tree is published with two durable renames. A crash in
// between keeps the old tree recoverable. No application data is merged by path.
func (s *applicationStorage) restore(backup ApplicationBackup) error {
	if s.root == "" || backup.Format != applicationBackupFormat || backup.Version != 1 || len(backup.Records) > 20000 {
		return errors.New("invalid application backup")
	}
	rename := s.renameTree
	if rename == nil {
		rename = commitPreferencesResetRename
	}
	stage, previous := s.root+".import", s.root+".previous"
	if err := recoverApplicationStorageImport(s.root); err != nil {
		return err
	}
	if err := os.Mkdir(stage, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	staged := applicationStorage{root: stage}
	if err := staged.writeBackupRecords(backup.Records); err != nil {
		return err
	}
	if err := rename(s.root, previous); err != nil {
		return errors.Join(err, recoverApplicationStorageImport(s.root))
	}
	if err := rename(stage, s.root); err != nil {
		// Rename may have succeeded before the directory sync failed. Move the
		// new tree back out before restoring the previous complete tree.
		if _, statErr := os.Lstat(stage); errors.Is(statErr, os.ErrNotExist) {
			if rollbackErr := rename(s.root, stage); rollbackErr != nil {
				return errors.Join(err, rollbackErr)
			}
		}
		return errors.Join(err, rename(previous, s.root))
	}
	// The new root is durable. Cleanup can be completed on the next startup.
	_ = os.RemoveAll(previous)
	return nil
}

func (s *applicationStorage) writeBackupRecords(records []ApplicationStorageRecord) error {
	seen := map[string]bool{}
	total := 0
	for _, record := range records {
		id := record.Namespace + "\x00" + record.Key
		total += len(record.Key) + len(record.Data.Value) + len(record.Data.MediaType)
		if seen[id] || total > applicationBackupLimit ||
			(record.Namespace == "renderer" && record.Data.Kind != "text") {
			return errors.New("invalid application backup record")
		}
		seen[id] = true
		if record.Namespace == "renderer" && isPersistedRendererKey(record.Key) {
			var object map[string]json.RawMessage
			if json.Unmarshal([]byte(record.Data.Value), &object) != nil || object == nil {
				return errors.New("invalid renderer backup record")
			}
		}
		if record.Namespace == "renderer" && record.Key == "native-window-appearance" {
			var value struct {
				UseBorderless *bool `json:"useBorderless"`
			}
			if json.Unmarshal([]byte(record.Data.Value), &value) != nil || value.UseBorderless == nil {
				return errors.New("invalid window appearance backup")
			}
		}
		if err := s.write(record.Namespace, record.Key, record.Data); err != nil {
			return err
		}
	}
	return nil
}

func isPersistedRendererKey(key string) bool {
	switch key {
	case "setting-store", "shortcut-store", "data-store", "music-store", "status-store":
		return true
	}
	return false
}

func recoverApplicationStorageImport(root string) error {
	previous := root + ".previous"
	_, previousErr := os.Lstat(previous)
	if previousErr == nil {
		if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
			if err := commitPreferencesResetRename(previous, root); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if err := os.RemoveAll(previous); err != nil {
			return err
		}
	} else if !errors.Is(previousErr, os.ErrNotExist) {
		return previousErr
	}
	return os.RemoveAll(root + ".import")
}

func (s *applicationStorage) restoreForContext(ctx context.Context, backup ApplicationBackup) error {
	if err := s.restore(backup); err != nil {
		_, previousErr := os.Lstat(s.root + ".previous")
		_, rootErr := os.Lstat(s.root)
		if previousErr == nil || errors.Is(rootErr, os.ErrNotExist) {
			s.frozen, s.recoveryRequired = ctx, true
		}
		return err
	}
	s.frozen = ctx
	return nil
}

func (*DesktopStorage) Restore(ctx context.Context, backup ApplicationBackup) error {
	var importedAppearance *WindowAppearance
	err := storageCall(ctx, func() error {
		if err := businessStorage.restoreForContext(ctx, backup); err != nil {
			return err
		}
		if value, err := businessStorage.read("renderer", "native-window-appearance"); err == nil && value != nil {
			var appearance WindowAppearance
			if json.Unmarshal([]byte(value.Value), &appearance) == nil {
				importedAppearance = &appearance
			}
		}
		return nil
	})
	if err == nil && importedAppearance != nil {
		// Never wait for the main thread while holding the storage mutex: a
		// settings action on that thread may itself be waiting for the mutex.
		mygo.RunOnMain(func() { desktopWindowAppearance.desired = *importedAppearance })
	}
	return err
}

func (*DesktopStorage) Export(ctx context.Context) (ApplicationBackup, error) {
	backup := ApplicationBackup{Format: applicationBackupFormat, Version: 1, Records: []ApplicationStorageRecord{}}
	err := storageCall(ctx, func() error {
		totalBytes := 0
		for _, namespace := range applicationStorageNamespaces {
			keys, err := businessStorage.keys(namespace)
			if err != nil {
				return err
			}
			for _, key := range keys {
				value, err := businessStorage.read(namespace, key)
				if err != nil {
					return err
				}
				if value != nil {
					totalBytes += len(value.Value) + len(key)
					if totalBytes > applicationBackupLimit {
						return errors.New("application backup too large")
					}
					backup.Records = append(backup.Records, ApplicationStorageRecord{Namespace: namespace, Key: key, Data: *value})
				}
			}
		}
		return nil
	})
	return backup, err
}
