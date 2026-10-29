package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadNativeCandidateConflictDoesNotPublishSidecars(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	if err := os.MkdirAll(filepath.Join(dir, "Artist", "Album"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Artist", "Album", "song.mp3"), []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	data := downloadMP3()
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: make(http.Header)}, nil
	})
	req := downloadReq(t, token, "song.mp3")
	req.Options = &DownloadOptions{RelativeDirectory: "Artist/Album", SaveSidecars: true, WriteLyrics: true, Metadata: &DownloadMetadata{Lyrics: "new"}}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || state.Code != "conflict" || state.Committed {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Artist", "Album", "song.lrc")); !os.IsNotExist(err) {
		t.Fatalf("sidecar leaked: %v", err)
	}
}

func TestDownloadNativeCandidateSidecarConflictKeepsAudioRef(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	if err := os.MkdirAll(filepath.Join(dir, "Artist", "Album"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Artist", "Album", "song.lrc"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	data := downloadMP3()
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: make(http.Header)}, nil
	})
	req := downloadReq(t, token, "song.mp3")
	req.Options = &DownloadOptions{RelativeDirectory: "Artist/Album", SaveSidecars: true, WriteLyrics: true, Metadata: &DownloadMetadata{Lyrics: "new"}}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || state.Code != "partial_committed" || !state.Committed || state.Ref == nil {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "Artist", "Album", "song.lrc")); err != nil || string(got) != "old" {
		t.Fatalf("old sidecar=%q err=%v", got, err)
	}
}
