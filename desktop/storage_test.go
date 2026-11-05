package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestApplicationStorageRoundTripAndBinaryOnDisk(t *testing.T) {
	store := &applicationStorage{root: t.TempDir()}
	binary := []byte{0, 1, 255, 0, 128}
	values := []struct {
		namespace, key string
		value          StorageValue
	}{
		{"renderer", "setting-store", StorageValue{Kind: "text", Value: `{"language":"zh-CN"}`}},
		{"music-data/music", "playList", StorageValue{Kind: "json", Value: `[{"id":"song"}]`}},
		{"background-data/background", "image", StorageValue{Kind: "blob", Value: base64.StdEncoding.EncodeToString(binary), MediaType: "image/png"}},
	}
	for _, item := range values {
		if err := store.write(item.namespace, item.key, item.value); err != nil {
			t.Fatal(err)
		}
		got, err := store.read(item.namespace, item.key)
		if err != nil || got == nil || *got != item.value {
			t.Fatalf("round trip: %+v, %v", got, err)
		}
		keys, err := store.keys(item.namespace)
		if err != nil || !reflect.DeepEqual(keys, []string{item.key}) {
			t.Fatalf("keys: %v %v", keys, err)
		}
	}
	path, _ := store.path("background-data/background", "image")
	data, err := os.ReadFile(path)
	if err != nil || !bytes.HasSuffix(data, binary) {
		t.Fatalf("binary was not persisted raw: %v", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private mode: %v", info.Mode())
	}
	// A second process/instance uses only the files, not browser storage.
	reopened := applicationStorage{root: store.root}
	if value, err := reopened.read("renderer", "setting-store"); err != nil || value == nil {
		t.Fatal(value, err)
	}
}

func TestApplicationStorageRejectsCorruptionWithoutOverwriting(t *testing.T) {
	store := &applicationStorage{root: t.TempDir()}
	path, _ := store.path("renderer", "setting-store")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte("damaged\noriginal")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.read("renderer", "setting-store"); err == nil {
		t.Fatal("corruption accepted")
	}
	if err := store.write("renderer", "setting-store", StorageValue{Kind: "text", Value: "defaults"}); err == nil {
		t.Fatal("overwrote corruption")
	}
	data, _ := os.ReadFile(path)
	if !bytes.Equal(data, original) {
		t.Fatal("original was modified")
	}
	if _, err := store.keys("renderer"); err == nil {
		t.Fatal("damaged index accepted")
	}
}

func TestApplicationStorageNamespacesAndResetBoundaries(t *testing.T) {
	directory := t.TempDir()
	store := &applicationStorage{root: filepath.Join(directory, applicationStorageDirectory)}
	for _, key := range []string{"setting-store", "shortcut-store", "data-store"} {
		if err := store.write("renderer", key, StorageValue{Kind: "text", Value: "{}"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.write("local-data/local_download_history", "history-v1", StorageValue{Kind: "json", Value: `{"tasks":[]}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.path("../../Music", "song"); err == nil {
		t.Fatal("unknown namespace accepted")
	}
	// Keys are data, including separators; they can never become paths.
	path, err := store.path("renderer", "../../Music")
	if err != nil || filepath.Dir(path) != filepath.Join(store.root, storageDigest("renderer")) {
		t.Fatal(path, err)
	}
	if err := resetApplicationStorage(directory, PreferencesResetSettings); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.read("renderer", "setting-store"); value != nil {
		t.Fatal("settings not reset")
	}
	for _, key := range []string{"shortcut-store", "data-store"} {
		if value, _ := store.read("renderer", key); value == nil {
			t.Fatal("unrelated data reset", key)
		}
	}
	if value, _ := store.read("local-data/local_download_history", "history-v1"); value == nil {
		t.Fatal("history reset")
	}
	if err := resetApplicationStorage(directory, PreferencesResetAll); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.root); !os.IsNotExist(err) {
		t.Fatalf("data not removed: %v", err)
	}
}
