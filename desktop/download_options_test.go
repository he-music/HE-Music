package main

import (
	"strings"
	"testing"
)

func TestDownloadNativeOptionsSnapshotIsBoundedAndImmutable(t *testing.T) {
	artists := []string{"a/b", "c"}
	in := &DownloadOptions{WriteMetadata: true, Metadata: &DownloadMetadata{Title: "title", Artists: artists}}
	got, err := downloadNativeOptionsSnapshot(in)
	if err != nil {
		t.Fatal(err)
	}
	in.Metadata.Artists[0] = "changed"
	if got.Metadata.Artists[0] != "a/b" {
		t.Fatal("snapshot aliases artists")
	}
	if downloadNativeOptionsFingerprint(&DownloadOptions{WriteMetadata: true, Metadata: &DownloadMetadata{Title: "a/b", Artists: []string{"c"}}}) == downloadNativeOptionsFingerprint(&DownloadOptions{WriteMetadata: true, Metadata: &DownloadMetadata{Title: "a", Artists: []string{"b/c"}}}) {
		t.Fatal("structured fingerprint collision")
	}
	tooLong := &DownloadOptions{WriteMetadata: true, Metadata: &DownloadMetadata{Lyrics: strings.Repeat("x", downloadOptionLyricsLimit+1)}}
	if _, err := downloadNativeOptionsSnapshot(tooLong); err == nil {
		t.Fatal("unbounded lyrics accepted")
	}
}

func TestDownloadNativeOptionsAllowsEmptyLyricsAndRejectsUnsafeCoverURL(t *testing.T) {
	if _, err := downloadNativeOptionsSnapshot(&DownloadOptions{WriteLyrics: true, Metadata: &DownloadMetadata{}}); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"https://user:pass@example.invalid/a", "https://example.invalid/a#x", "file:///tmp/a"} {
		if _, err := downloadNativeOptionsSnapshot(&DownloadOptions{WriteCover: true, Metadata: &DownloadMetadata{CoverURL: raw}}); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}

func TestDownloadNativeOptionsDropsUnneededMetadataWhenFlagsAreOff(t *testing.T) {
	in := &DownloadOptions{Metadata: &DownloadMetadata{Lyrics: strings.Repeat("x", downloadOptionLyricsLimit+1)}}
	got, err := downloadNativeOptionsSnapshot(in)
	if err != nil || got != nil {
		t.Fatalf("unneeded metadata was retained: got=%v err=%v", got, err)
	}
	in = &DownloadOptions{Metadata: &DownloadMetadata{Artists: make([]string, downloadOptionArtistsLimit+1)}}
	got, err = downloadNativeOptionsSnapshot(in)
	if err != nil || got != nil {
		t.Fatalf("unneeded artists were retained: got=%v err=%v", got, err)
	}
}
