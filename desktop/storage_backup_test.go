package main

import (
	"context"
	"errors"
	"os"
	"testing"
)

func TestApplicationBackupPublishesCompleteTreeAndKeepsOldOnInvalidInput(t *testing.T) {
	store := applicationStorage{root: t.TempDir()}
	old := StorageValue{Kind: "text", Value: `{"language":"zh-CN"}`}
	if err := store.write("renderer", "setting-store", old); err != nil {
		t.Fatal(err)
	}
	backup := ApplicationBackup{Format: applicationBackupFormat, Version: 1, Records: []ApplicationStorageRecord{
		{Namespace: "renderer", Key: "setting-store", Data: StorageValue{Kind: "text", Value: `{"language":"en"}`}},
		{Namespace: "music-data/music", Key: "historyList", Data: StorageValue{Kind: "json", Value: `[{"id":"song"}]`}},
	}}
	invalid := backup
	invalid.Records = append(append([]ApplicationStorageRecord{}, backup.Records...), backup.Records[0])
	if err := store.restore(invalid); err == nil {
		t.Fatal("duplicate accepted")
	}
	if value, err := store.read("renderer", "setting-store"); err != nil || value == nil || *value != old {
		t.Fatal("original changed", value, err)
	}
	if err := store.restore(backup); err != nil {
		t.Fatal(err)
	}
	if value, err := store.read("renderer", "setting-store"); err != nil || value == nil || *value != backup.Records[0].Data {
		t.Fatal(value, err)
	}
	if value, err := store.read("music-data/music", "historyList"); err != nil || value == nil {
		t.Fatal(value, err)
	}
	if _, err := os.Stat(store.root + ".previous"); !os.IsNotExist(err) {
		t.Fatal("previous tree not cleaned")
	}
}

func TestApplicationBackupRecoveryRollsBackIncompleteAndKeepsCommittedTree(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "interrupted", true: "committed"}[committed], func(t *testing.T) {
			store := applicationStorage{root: t.TempDir()}
			if err := store.write("renderer", "key", StorageValue{Kind: "text", Value: "old"}); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(store.root, store.root+".previous"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(store.root+".import", 0700); err != nil {
				t.Fatal(err)
			}
			if committed {
				if err := store.write("renderer", "key", StorageValue{Kind: "text", Value: "new"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := recoverApplicationStorageImport(store.root); err != nil {
				t.Fatal(err)
			}
			value, err := store.read("renderer", "key")
			want := "old"
			if committed {
				want = "new"
			}
			if err != nil || value == nil || value.Value != want {
				t.Fatal(value, err)
			}
			if _, err := os.Stat(store.root + ".import"); !os.IsNotExist(err) {
				t.Fatal("staging not cleaned")
			}
		})
	}
}

func TestApplicationBackupFailedRollbackFencesOldWritesUntilRecovery(t *testing.T) {
	store := applicationStorage{root: t.TempDir()}
	if err := store.write("renderer", "setting-store", StorageValue{Kind: "text", Value: "old"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	store.renameTree = func(from, to string) error {
		calls++
		if calls > 1 {
			return errors.New("simulated disk failure")
		}
		return commitPreferencesResetRename(from, to)
	}
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	backup := ApplicationBackup{Format: applicationBackupFormat, Version: 1, Records: []ApplicationStorageRecord{}}
	if err := store.withContext(owner, func() error { return store.restoreForContext(owner, backup) }); err == nil {
		t.Fatal("fault was ignored")
	}
	if !store.recoveryRequired {
		t.Fatal("rollback failure was not fenced")
	}
	if err := store.withContext(owner, func() error {
		return store.write("renderer", "setting-store", StorageValue{Kind: "text", Value: "defaults"})
	}); err == nil {
		t.Fatal("old page overwrote recovery")
	}
	fresh, stop := context.WithCancel(context.Background())
	defer stop()
	if err := store.withContext(fresh, func() error {
		value, err := store.read("renderer", "setting-store")
		if err != nil || value == nil || value.Value != "old" {
			t.Fatal("old tree was lost", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if store.recoveryRequired {
		t.Fatal("fresh document did not recover")
	}
}
