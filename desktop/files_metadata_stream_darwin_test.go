//go:build darwin

package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestMetadataSaveDrainsActualStreamRequests(t *testing.T) {
	for _, format := range []string{"mp3", "flac"} {
		t.Run(format, func(t *testing.T) {
			dir := metadataFixture(t, format)
			files, ctx, epoch, ref := metadataTestService(t, dir)
			read := files.ReadMetadata(ctx, epoch, ref)
			if read.Code != "ok" {
				t.Fatal(read.Code)
			}
			before := metadataPackets(t, filepath.Join(dir, "song.mp3"))
			a := audioServerFor(&files.state)
			a.host = "127.0.0.1:34567" // Only fake HTTP; never bind a listener.
			ticket := audioOpen(t, a, ctx, epoch, ref)
			writer := &audioBlockedWriter{header: make(http.Header), entered: make(chan struct{}), released: make(chan struct{})}
			done := make(chan struct{})
			go func() {
				defer close(done)
				a.ServeHTTP(writer, httptest.NewRequest("GET", ticket.URL, nil))
			}()
			audioAwait(t, writer.entered)
			title, lyrics := "已写入原件", "[00:00.00]本地歌词"
			result := files.SaveMetadata(ctx, epoch, MetadataSaveRequest{
				OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256,
				Patch: metadata.Patch{Title: &title, Lyrics: &lyrics},
			})
			if result.Code != "ok" || !result.Committed || result.Ref == nil || result.Info == nil {
				t.Fatalf("save failed: code=%s committed=%v", result.Code, result.Committed)
			}
			audioAwait(t, done)
			if result.Info.Title != title || result.Info.Lyrics != lyrics || result.Ref.Version == ref.Version {
				t.Fatal("saved tags or file version did not update")
			}
			if !bytes.Equal(before, metadataPackets(t, filepath.Join(dir, "song.mp3"))) {
				t.Fatal("original audio packets changed")
			}
			if old := audioRequest(a, ticket, "GET", ""); old.Code != 404 {
				t.Fatal("old source ticket survived replacement")
			}
			lease, err := files.state.acquireDirectory(ctx, epoch, ref.GrantToken)
			if err != nil {
				t.Fatal(err)
			}
			old, err := files.state.resolveLocalFile(lease, ref)
			lease.Release()
			if old != nil {
				old.Close()
				t.Fatal("old file reference survived replacement")
			}
			if err == nil {
				t.Fatal("old file reference was accepted")
			}
			reopened := audioOpen(t, a, ctx, epoch, *result.Ref)
			if next := audioRequest(a, reopened, "GET", "bytes=-10"); next.Code != 206 {
				t.Fatal("new version failed Range playback")
			}
			a.mu.Lock()
			count := len(a.readers) + len(a.writeGates)
			a.mu.Unlock()
			if count != 0 {
				t.Fatal("metadata write gate or stream reader leaked")
			}
		})
	}
}
