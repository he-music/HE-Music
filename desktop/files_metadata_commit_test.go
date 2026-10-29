package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMetadataCommitDirectoryPolicy(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := metadataPrepareCommitDirectory(root); err != nil {
		t.Fatalf("ordinary directory must permit preparation: %v", err)
	}
	durable, err := metadataCommitDirectoryDurability(root)
	if err != nil {
		t.Fatal(err)
	}
	if want := runtime.GOOS != "windows"; durable != want {
		t.Fatalf("directory durability = %v, want %v", durable, want)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if err := metadataPrepareCommitDirectory(root); err == nil {
		t.Fatal("preparation hid a closed-root error")
	}
	if durable, err := metadataCommitDirectoryDurability(root); err == nil || durable {
		t.Fatalf("closed root must be a real error, got durable=%v err=%v", durable, err)
	}
}

// Exercise the required sequence against real files. Windows can run this as
// an ordinary user: no symlink creation or volume/admin handle is required.
func TestMetadataCommitReplacementKeepsIndependentBackup(t *testing.T) {
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for name, content := range map[string]string{
		"original": "old audio", "backup": "old audio", "work": "new tags and audio",
	} {
		file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteString(content); err != nil {
			t.Fatal(err)
		}
		if err := file.Sync(); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	original, err := root.Stat("original")
	if err != nil {
		t.Fatal(err)
	}
	backup, err := root.Stat("backup")
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(original, backup) {
		t.Fatal("backup must not be a hard link")
	}
	if err := metadataPrepareCommitDirectory(root); err != nil {
		t.Fatal(err)
	}
	if err := root.Rename("work", "original"); err != nil {
		t.Fatal(err)
	}
	if _, err := metadataCommitDirectoryDurability(root); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"original": "new tags and audio", "backup": "old audio"} {
		got, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v; want %q", name, got, err, want)
		}
	}
	if replacement, err := root.Stat("original"); err != nil || os.SameFile(original, replacement) {
		t.Fatalf("replacement must have a new identity: %v", err)
	}
	if _, err := root.Stat("work"); !os.IsNotExist(err) {
		t.Fatalf("staged name still exists: %v", err)
	}
}

func TestMetadataCommitRenameRemainsRootConfined(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "grant"), 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(filepath.Join(directory, "grant"))
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.WriteFile(filepath.Join(directory, "outside"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "grant", "work"), []byte("staged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := metadataPrepareCommitDirectory(root); err != nil {
		t.Fatal(err)
	}
	if err := root.Rename("work", "../outside"); err == nil {
		t.Fatal("rename escaped the pinned root")
	}
	if got, err := os.ReadFile(filepath.Join(directory, "outside")); err != nil || string(got) != "untouched" {
		t.Fatalf("outside changed: %q %v", got, err)
	}
}
