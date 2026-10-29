package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadNativeCandidateCreatesOnlyValidatedRootChildren(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	child, name, err := downloadNativeOpenTarget(root, "Artist/Album/song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	defer child.Close()
	if name != "song.mp3" {
		t.Fatalf("basename = %q", name)
	}
	for _, target := range []string{"../escape.mp3", "/absolute.mp3", `C:\escape.mp3`, "Artist/../escape.mp3"} {
		if _, _, err := downloadNativeOpenTarget(root, target); err == nil {
			t.Errorf("unsafe target accepted: %q", target)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "Artist", "Album")); err != nil {
		t.Fatalf("candidate test escaped temp root: %v", err)
	}
}
