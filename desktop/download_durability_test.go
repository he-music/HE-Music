package main

import (
	"os"
	"testing"
)

func TestDownloadCommitDirectoryDurabilityUsesPlatformPolicy(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	durable, err := downloadCommitDirectoryDurability(root)
	if err != nil {
		t.Fatal(err)
	}
	if !durable {
		t.Skip("platform does not expose directory fsync; caller must publish fresh ref with durability_uncertain")
	}
}
