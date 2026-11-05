package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func displayJPEG(t *testing.T, red uint8) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	picture.Set(0, 0, color.RGBA{R: red, A: 255})
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, picture, nil); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func displayFixture(t *testing.T, embedded bool) (*NativeFiles, context.Context, uint64, LocalFileRef, string, []byte) {
	t.Helper()
	dir := t.TempDir()
	filename := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(filename, downloadMP3(), 0o600); err != nil {
		t.Fatal(err)
	}
	picture := displayJPEG(t, 255)
	if embedded {
		file, err := os.OpenFile(filename, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		lyrics := "[00:01.00]embedded"
		pictures := []metadata.Picture{{MIME: "image/jpeg", Type: 3, Data: picture}}
		err = metadata.EditWorkingCopy(context.Background(), file, int64(len(downloadMP3())), metadata.Patch{Lyrics: &lyrics, Pictures: &pictures})
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	files, ctx, epoch, ref := metadataTestService(t, dir)
	return files, ctx, epoch, ref, dir, picture
}

func TestLocalDisplayEmbeddedArtworkAndSidecarLyricsPriority(t *testing.T) {
	files, ctx, epoch, ref, dir, embedded := displayFixture(t, true)
	if err := os.WriteFile(filepath.Join(dir, "song.jpg"), displayJPEG(t, 0), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "song.lrc"), []byte("[00:01.00]sidecar"), 0o600); err != nil {
		t.Fatal(err)
	}
	artwork := files.ReadLocalArtwork(ctx, epoch, ref)
	if artwork.Code != "ok" || artwork.SHA256 != "" || artwork.Info == nil || len(artwork.Info.Pictures) != 1 || !bytes.Equal(artwork.Info.Pictures[0].Data, embedded) {
		t.Fatalf("artwork result: %s", artwork.Code)
	}
	lyrics := files.ReadLocalLyrics(ctx, epoch, ref)
	if lyrics.Code != "ok" || lyrics.SHA256 != "" || lyrics.Info.Lyrics != "[00:01.00]sidecar" {
		t.Fatalf("lyrics result: %s", lyrics.Code)
	}
	if err := os.Remove(filepath.Join(dir, "song.lrc")); err != nil {
		t.Fatal(err)
	}
	lyrics = files.ReadLocalLyrics(ctx, epoch, ref)
	if lyrics.Info == nil || lyrics.Info.Lyrics != "[00:01.00]embedded" {
		t.Fatalf("embedded lyrics result: %s", lyrics.Code)
	}
}

func TestLocalDisplayMalformedTagsStillUseSameNameJPG(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("malformed tags"), 0o600); err != nil {
		t.Fatal(err)
	}
	picture := displayJPEG(t, 255)
	if err := os.WriteFile(filepath.Join(dir, "song.jpg"), picture, 0o600); err != nil {
		t.Fatal(err)
	}
	files, ctx, epoch, ref := metadataTestService(t, dir)
	result := files.ReadLocalArtwork(ctx, epoch, ref)
	if result.Code != "ok" || result.Info == nil || len(result.Info.Pictures) != 1 || !bytes.Equal(result.Info.Pictures[0].Data, picture) {
		t.Fatalf("result: %s", result.Code)
	}
}

func TestLocalDisplayDetectsPNGInSameNameSidecar(t *testing.T) {
	files, ctx, epoch, ref, dir, _ := displayFixture(t, false)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "song.jpg"), encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	result := files.ReadLocalArtwork(ctx, epoch, ref)
	if result.Code != "ok" || result.Info == nil || len(result.Info.Pictures) != 1 {
		t.Fatalf("PNG sidecar result: %s", result.Code)
	}
	picture := result.Info.Pictures[0]
	if picture.MIME != "image/png" || !bytes.Equal(picture.Data, encoded.Bytes()) {
		t.Fatal("sidecar MIME or bytes changed")
	}
}

func TestLocalDisplayRejectsSidecarSymlinkOversizeAndStaleAudio(t *testing.T) {
	files, ctx, epoch, ref, dir, picture := displayFixture(t, false)
	outside := filepath.Join(t.TempDir(), "outside.jpg")
	if err := os.WriteFile(outside, picture, 0o600); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(dir, "song.jpg")
	if err := os.Symlink(outside, name); err != nil {
		t.Fatal(err)
	}
	result := files.ReadLocalArtwork(ctx, epoch, ref)
	if result.Info == nil || len(result.Info.Pictures) != 0 {
		t.Fatal("symlink sidecar escaped grant")
	}
	os.Remove(name)
	if err := os.WriteFile(name, make([]byte, displayImageLimit+1), 0o600); err != nil {
		t.Fatal(err)
	}
	result = files.ReadLocalArtwork(ctx, epoch, ref)
	if result.Info == nil || len(result.Info.Pictures) != 0 {
		t.Fatal("oversize sidecar admitted")
	}
	replacement := filepath.Join(dir, "replacement.mp3")
	requireTestNoError(t, os.WriteFile(replacement, downloadMP3(), 0o600))
	requireTestNoError(t, os.Rename(replacement, filepath.Join(dir, "song.mp3")))
	if got := files.ReadLocalArtwork(ctx, epoch, ref); got.Code == "ok" {
		t.Fatal("stale ref accepted")
	}
}

func TestLocalDisplayCancellationBudgetAndRevocation(t *testing.T) {
	reader := &displayReader{ctx: context.Background(), source: bytes.NewReader([]byte("abc")), remaining: 2}
	if _, err := reader.ReadAt(make([]byte, 3), 0); !errors.Is(err, errMetadataLimit) {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	reader.ctx = cancelled
	if _, err := reader.ReadAt(make([]byte, 1), 0); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	files, ctx, epoch, ref, _, _ := displayFixture(t, false)
	files.state.dispatch(files.state.revoke)
	if got := files.ReadLocalLyrics(ctx, epoch, ref); got.Code == "ok" {
		t.Fatal("revoked grant accepted")
	}
}

func TestLocalDisplayQueuedCancellationAndTextBounds(t *testing.T) {
	files, ctx, epoch, ref, dir, _ := displayFixture(t, true)
	for i := 0; i < cap(localDisplaySlots); i++ {
		localDisplaySlots <- struct{}{}
	}
	cancelled, cancel := context.WithCancel(ctx)
	done := make(chan MetadataResult, 1)
	go func() { done <- files.ReadLocalArtwork(cancelled, epoch, ref) }()
	cancel()
	result := <-done
	for i := 0; i < cap(localDisplaySlots); i++ {
		<-localDisplaySlots
	}
	if result.Code == "ok" {
		t.Fatal("cancelled queued display request succeeded")
	}
	for _, data := range [][]byte{make([]byte, displayLyricsLimit+1), {0xff, 0xfe, 0}} {
		if err := os.WriteFile(filepath.Join(dir, "song.lrc"), data, 0o600); err != nil {
			t.Fatal(err)
		}
		lyrics := files.ReadLocalLyrics(ctx, epoch, ref)
		if lyrics.Info == nil || lyrics.Info.Lyrics != "[00:01.00]embedded" {
			t.Fatalf("invalid text must use embedded lyrics: %s", lyrics.Code)
		}
	}
}

func TestLocalDisplayDoesNotApplyArtworkByteLimitToSongSize(t *testing.T) {
	dir := t.TempDir()
	source, err := os.Create(filepath.Join(dir, "song.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Write(downloadMP3()); err != nil {
		t.Fatal(err)
	}
	if err := source.Truncate(128 << 20); err != nil {
		t.Fatal(err)
	}
	source.Close()
	picture := displayJPEG(t, 255)
	if err := os.WriteFile(filepath.Join(dir, "song.jpg"), picture, 0o600); err != nil {
		t.Fatal(err)
	}
	files, ctx, epoch, ref := metadataTestService(t, dir)
	result := files.ReadLocalArtwork(ctx, epoch, ref)
	if result.Code != "ok" || result.Info == nil || len(result.Info.Pictures) != 1 || result.SHA256 != "" {
		t.Fatalf("large audio display read: %s", result.Code)
	}
}
