//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMetadataCommitDirectoryStaysPinnedAfterRouteReplacement(t *testing.T) {
	base := t.TempDir()
	authorized := filepath.Join(base, "authorized")
	moved := filepath.Join(base, "moved")
	outside := filepath.Join(base, "outside")
	for _, directory := range []string{authorized, outside} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "original"), []byte("old"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(authorized, "work"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(authorized)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Rename(authorized, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, authorized); err != nil {
		t.Fatal(err)
	}
	// The caller must still reject a changed authorization route before commit.
	// This lower-level test proves the helpers do not reopen root.Name() even
	// when that name now resolves through a symlink to an unrelated directory.
	if err := metadataPrepareCommitDirectory(root); err != nil {
		t.Fatal(err)
	}
	if err := root.Rename("work", "original"); err != nil {
		t.Fatal(err)
	}
	if durable, err := metadataCommitDirectoryDurability(root); err != nil || !durable {
		t.Fatalf("sync pinned directory: durable=%v err=%v", durable, err)
	}
	for directory, want := range map[string]string{moved: "new", outside: "old"} {
		got, err := os.ReadFile(filepath.Join(directory, "original"))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v; want %q", directory, got, err, want)
		}
	}
}
