package main

import (
	"os"
	"path/filepath"
	"testing"
)

func preserveLibraryIndex(t *testing.T) {
	t.Helper()
	savedLibraryIndex.Lock()
	path, entries, err, dirty := savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err, savedLibraryIndex.dirty
	savedLibraryIndex.Unlock()
	t.Cleanup(func() {
		savedLibraryIndex.Lock()
		defer savedLibraryIndex.Unlock()
		savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err, savedLibraryIndex.dirty = path, entries, err, dirty
	})
}

func TestUnchangedLibraryScanDoesNotReplaceIndex(t *testing.T) {
	preserveLibraryIndex(t)
	actor, ctx, epoch, token, music := scanTestGrant(t)
	directory := t.TempDir()
	requireTestNoError(t, prepareLibraryIndex(directory))
	scanTestWrite(t, filepath.Join(music, "song.mp3"), []byte("fallback metadata"))
	entries, issues := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != 1 || len(issues) != 0 {
		t.Fatalf("initial scan: %d entries, %+v", len(entries), issues)
	}
	path := filepath.Join(directory, "local-library-index.json")
	before, err := os.Stat(path)
	requireTestNoError(t, err)
	entries, issues = scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != 1 || len(issues) != 0 || entries[0].Ref.FileID == "" {
		t.Fatalf("cached scan: %d entries, %+v", len(entries), issues)
	}
	after, err := os.Stat(path)
	requireTestNoError(t, err)
	if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("unchanged scan replaced the durable index")
	}
	// Changed audio still invalidates the cached stamp and reaches durable storage.
	scanTestWrite(t, filepath.Join(music, "song.mp3"), []byte("changed file length and metadata"))
	entries, issues = scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != 1 || len(issues) != 0 {
		t.Fatalf("changed scan: %d entries, %+v", len(entries), issues)
	}
	changed, err := os.Stat(path)
	requireTestNoError(t, err)
	if os.SameFile(after, changed) {
		t.Fatal("changed scan did not save the index")
	}
}

func TestLibraryIndexRetriesDirtyFlushAndPersistsInvalidation(t *testing.T) {
	preserveLibraryIndex(t)
	actor, ctx, epoch, token, music := scanTestGrant(t)
	directory := t.TempDir()
	requireTestNoError(t, prepareLibraryIndex(directory))
	scanTestWrite(t, filepath.Join(music, "song.mp3"), []byte("fallback metadata"))
	scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	canonical, err := filepath.EvalSymlinks(music)
	requireTestNoError(t, err)
	invalidateLibraryMetadata(canonical, "song.mp3")
	savedLibraryIndex.Lock()
	path := savedLibraryIndex.path
	savedLibraryIndex.path = directory
	savedLibraryIndex.Unlock()
	if flushLibraryIndex() == nil {
		t.Fatal("failed flush was accepted")
	}
	savedLibraryIndex.Lock()
	dirty := savedLibraryIndex.dirty
	savedLibraryIndex.path = path
	savedLibraryIndex.Unlock()
	if !dirty {
		t.Fatal("failed flush discarded pending changes")
	}
	requireTestNoError(t, flushLibraryIndex())
	requireTestNoError(t, prepareLibraryIndex(directory))
	info, err := os.Stat(filepath.Join(music, "song.mp3"))
	requireTestNoError(t, err)
	if _, found := cachedLibraryMetadata(canonical, "song.mp3", info); found {
		t.Fatal("invalidated entry returned after reload")
	}
}
