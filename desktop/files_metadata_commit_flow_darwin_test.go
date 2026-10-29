//go:build darwin

package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

// Exercise the production save flow with an explicit platform durability result.
// This is a Darwin fixture test, not execution of the Windows filesystem APIs.
func TestMetadataSavePublishesReferenceWhenDirectoryDurabilityIsUnsupported(t *testing.T) {
	for _, ioFailure := range []bool{false, true} {
		t.Run(map[bool]string{false: "unsupported", true: "io-failure"}[ioFailure], func(t *testing.T) {
			dir := metadataFixture(t, "mp3")
			original, err := os.ReadFile(filepath.Join(dir, "song.mp3"))
			if err != nil {
				t.Fatal(err)
			}
			f, ctx, epoch, ref := metadataTestService(t, dir)
			read := f.ReadMetadata(ctx, epoch, ref)
			if read.Code != "ok" {
				t.Fatal(read)
			}
			previous := metadataDirectoryDurability
			t.Cleanup(func() { metadataDirectoryDurability = previous })
			metadataDirectoryDurability = func(root *os.Root) (bool, error) {
				if _, err := root.Stat("."); err != nil {
					return false, err
				}
				if ioFailure {
					return false, errors.New("fixture directory sync failure")
				}
				return false, nil
			}
			title := "目录持久性策略回归"
			result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256, Patch: metadata.Patch{Title: &title}})
			if result.Code != "durability_uncertain" || !result.Committed || result.RecoveryName == "" {
				t.Fatalf("%+v", result)
			}
			backup, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(result.RecoveryName)))
			if err != nil || !bytes.Equal(backup, original) {
				t.Fatalf("recovery differs: %v", err)
			}
			if ioFailure {
				if result.Ref != nil {
					t.Fatal("I/O failure was published as a complete result")
				}
				return
			}
			if result.Ref == nil || *result.Ref == ref || result.Info == nil || result.Info.Title != title || result.SHA256 == "" {
				t.Fatalf("fresh result missing: %+v", result)
			}
			if reread := f.ReadMetadata(ctx, epoch, *result.Ref); reread.Code != "ok" || reread.Info.Title != title {
				t.Fatalf("fresh ref unusable: %+v", reread)
			}
			if old := f.ReadMetadata(ctx, epoch, ref); old.Code != "conflict" {
				t.Fatalf("old ref survived replacement: %+v", old)
			}
		})
	}
}
