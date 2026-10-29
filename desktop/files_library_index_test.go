package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestLibraryIndexPersistsMetadataWithoutCapabilities(t *testing.T) {
	savedLibraryIndex.Lock()
	oldPath, oldEntries, oldErr := savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err
	savedLibraryIndex.Unlock()
	t.Cleanup(func() {
		savedLibraryIndex.Lock()
		savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err = oldPath, oldEntries, oldErr
		savedLibraryIndex.Unlock()
	})
	directory := t.TempDir()
	music := t.TempDir()
	name := filepath.Join(music, "song.wav")
	if err := os.WriteFile(name, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareLibraryIndex(directory); err != nil {
		t.Fatal(err)
	}
	rememberLibraryMetadata(music, "song.wav", info, metadata.Info{Title: "持久标题", Artists: []string{"歌手"}, PicturesLoaded: true, Pictures: []metadata.Picture{{Data: []byte("not persisted")}}})
	if err := flushLibraryIndex(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "local-library-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"grantToken", "fileId", "version\":\"", "ticket", "not persisted"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("transient capability in index: %s", secret)
		}
	}
	var document libraryIndexDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Entries) != 1 {
		t.Fatal(document)
	}
	// A new startup reloads the durable index, but validates the current file stamp.
	if err := prepareLibraryIndex(directory); err != nil {
		t.Fatal(err)
	}
	value, ok := cachedLibraryMetadata(music, "song.wav", info)
	if !ok || value.Title != "持久标题" || value.PicturesLoaded || len(value.Pictures) != 0 {
		t.Fatalf("%+v %v", value, ok)
	}
	if err := os.WriteFile(name, []byte("changed length"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, _ := os.Stat(name)
	if _, ok := cachedLibraryMetadata(music, "song.wav", changed); ok {
		t.Fatal("changed file reused cached metadata")
	}
	if err := os.WriteFile(filepath.Join(directory, "local-library-index.json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if prepareLibraryIndex(directory) == nil || flushLibraryIndex() == nil {
		t.Fatal("corrupt index silently replaced")
	}
	data, _ = os.ReadFile(filepath.Join(directory, "local-library-index.json"))
	if string(data) != "corrupt" {
		t.Fatal("corrupt data was overwritten")
	}
}

func TestAllLocalFormatsAreCollectedWithoutTagParsingPrerequisite(t *testing.T) {
	actor, ctx, epoch, token, directory := scanTestGrant(t)
	for ext := range localAudioExtensions {
		// Deliberately incomplete tags: a filename candidate must remain visible.
		scanTestWrite(t, filepath.Join(directory, "song"+ext), []byte("no readable tags"))
	}
	entries, _ := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != len(localAudioExtensions) {
		t.Fatalf("got %d formats, want %d", len(entries), len(localAudioExtensions))
	}
	for _, entry := range entries {
		if entry.Ref.FileID == "" || entry.Metadata.Title == "" {
			t.Fatalf("candidate lacks fallback/ref: %+v", entry)
		}
	}
}

func TestLocalAudioHeaderProbeHasNoWholeFileSizeGate(t *testing.T) {
	for ext, want := range localAudioExtensions {
		file, err := os.Create(filepath.Join(t.TempDir(), "song"+ext))
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate((3 << 30) + 1); err != nil {
			t.Fatal(err)
		}
		mime, err := localAudioMIME(file)
		file.Close()
		if err != nil || mime != want {
			t.Fatalf("%s: mime=%s err=%v", ext, mime, err)
		}
	}
}

func TestLibraryIndexRejectsTrailingValuesWithoutOverwrite(t *testing.T) {
	directory := t.TempDir()
	for _, suffix := range []string{"BROKEN", "{}"} {
		raw := `{"version":1,"entries":[]}` + suffix
		path := filepath.Join(directory, "local-library-index.json")
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if prepareLibraryIndex(directory) == nil || flushLibraryIndex() == nil {
			t.Fatal("trailing data accepted")
		}
		after, _ := os.ReadFile(path)
		if string(after) != raw {
			t.Fatal("trailing damage overwritten")
		}
	}
	savedLibraryIndex.Lock()
	savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err = "", nil, nil
	savedLibraryIndex.Unlock()
}
