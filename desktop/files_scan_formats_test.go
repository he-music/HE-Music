package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestScanFiltersNonAudioNamesBeforeParsingAndCache(t *testing.T) {
	actor, ctx, epoch, ref, data, source := audioFixture(t, "mp3")
	directory := filepath.Dir(source)
	if err := os.Mkdir(filepath.Join(directory, "album.xml"), 0700); err != nil {
		t.Fatal(err)
	}
	// Even readable audio bytes must not make an unrelated suffix a music entry.
	for _, name := range []string{"manifest.xml", "bundle.APK", "cover.jpg", "song.mp3.xml", "playlist.m3u", "no-extension", "album.xml/package.apk"} {
		scanTestWrite(t, filepath.Join(directory, filepath.FromSlash(name)), data)
	}
	scanTestWrite(t, filepath.Join(directory, "song.MP3"), data)
	scanTestWrite(t, filepath.Join(directory, "album.xml/fallback.FLAC"), []byte("unreadable tags"))

	savedLibraryIndex.Lock()
	oldPath, oldEntries, oldErr := savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err
	savedLibraryIndex.Unlock()
	t.Cleanup(func() {
		savedLibraryIndex.Lock()
		savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err = oldPath, oldEntries, oldErr
		savedLibraryIndex.Unlock()
	})
	if err := prepareLibraryIndex(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cached.xml", "cached.apk"} {
		path := filepath.Join(directory, name)
		scanTestWrite(t, path, []byte("not audio"))
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		rememberLibraryMetadata(canonical, name, info, metadata.Info{Title: "旧索引误识别", SampleRateHz: 44100, Channels: 2})
		if _, ok := cachedLibraryMetadata(canonical, name, info); !ok {
			t.Fatal("missing legacy cache fixture")
		}
	}

	entries, issues := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, ref.GrantToken))
	if len(issues) != 0 {
		t.Errorf("non-audio files should be skipped without scan warnings: %+v", issues)
	}
	want := map[string]bool{"song.MP3": true, "album.xml/fallback.FLAC": true}
	for _, entry := range entries {
		if !want[entry.RelativePath] {
			t.Errorf("non-audio filename collected: %s", entry.RelativePath)
		}
		delete(want, entry.RelativePath)
	}
	if len(entries) != 2 || len(want) != 0 {
		t.Fatalf("supported audio missing or extra files collected: entries=%d missing=%v", len(entries), want)
	}
}

func TestScanAudioGlobMatchesSupportedFormatsAtEveryDepth(t *testing.T) {
	actor, ctx, epoch, token, directory := scanTestGrant(t)
	nested := "Album [Live]/{Disc}"
	if err := os.MkdirAll(filepath.Join(directory, filepath.FromSlash(nested)), 0700); err != nil {
		t.Fatal(err)
	}
	want := make(map[string]bool)
	for ext := range localAudioExtensions {
		for _, name := range []string{"root" + ext, nested + "/Track" + strings.ToUpper(ext)} {
			scanTestWrite(t, filepath.Join(directory, filepath.FromSlash(name)), []byte("unreadable tags"))
			want[name] = true
		}
	}
	entries, issues := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(issues) != 0 || len(entries) != len(want) {
		t.Fatalf("glob results: entries=%d want=%d issues=%v", len(entries), len(want), issues)
	}
	for _, entry := range entries {
		if !want[entry.RelativePath] {
			t.Errorf("unexpected glob result: %s", entry.RelativePath)
		}
		delete(want, entry.RelativePath)
	}
	if len(want) != 0 {
		t.Fatalf("glob missed audio files: %v", want)
	}
}
