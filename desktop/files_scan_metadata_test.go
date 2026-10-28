package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScanExcludesPrivateFileArtifactsAtEveryLevel(t *testing.T) {
	a, ctx, epoch, ref, data, source := audioFixture(t, "mp3")
	dir := filepath.Dir(source)
	for _, prefix := range []string{metadataPrivatePrefix, downloadPrivatePrefix} {
		for _, relative := range []string{
			prefix + "backup",
			"album/" + prefix + "work",
			prefix + "recovery/song.mp3",
		} {
			name := filepath.Join(dir, filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
				t.Fatal(err)
			}
			scanTestWrite(t, name, data)
		}
	}
	job := scanTestJob(t, a.state, ctx, epoch, ref.GrantToken)
	entries, issues := scanTestDrain(t, job)
	if len(issues) != 0 || len(entries) != 1 || entries[0].RelativePath != "fixture.data" {
		t.Fatalf("private artifact was scanned: %d entries, %d issues", len(entries), len(issues))
	}
}
