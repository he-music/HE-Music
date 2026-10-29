package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadNativeCandidateTransferWithNestedOptions(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	data := downloadMP3()
	c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: make(http.Header)}, nil
	})
	req := downloadReq(t, token, "song.mp3")
	req.Options = &DownloadOptions{RelativeDirectory: "Artist/Album", SaveSidecars: true, WriteLyrics: true, Metadata: &DownloadMetadata{Lyrics: "[00:00.00] lyric"}}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || !state.Done || !state.Committed || state.Ref == nil || state.Ref.RelativePath != "Artist/Album/song.mp3" {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if state.Code != "ok" && state.Code != "durability_uncertain" {
		t.Fatalf("state=%+v", state)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "Artist", "Album", "song.lrc")); err != nil || string(got) != "[00:00.00] lyric" {
		t.Fatalf("lyrics=%q err=%v", got, err)
	}
}
