//go:build darwin

package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestMetadataSavePreservesOpaqueTrailer(t *testing.T) {
	for _, format := range []string{"flac", "mp3"} {
		t.Run(format, func(t *testing.T) {
			dir := metadataFixture(t, format)
			path := filepath.Join(dir, "song.mp3")
			trailer := []byte{0xf0, 0, 0xff, 0x0f, 0x44, 0x44, 0x40, 0x48, 0x46, 0x3c, 0x36, 0x0e, 0x55, 0xff, 0xf0}
			before, err := os.ReadFile(path)
			requireTestNoError(t, err)
			requireTestNoError(t, os.WriteFile(path, append(before, trailer...), 0o600))
			verifyMetadataTrailerSave(t, dir, trailer)
		})
	}
}

func TestMetadataFLACSampleTrailerSave(t *testing.T) {
	sample := os.Getenv("HE_MUSIC_FLAC_SAMPLE")
	if sample == "" {
		t.Skip("optional read-only FLAC sample not configured")
	}
	source, err := os.Open(sample)
	requireTestNoError(t, err)
	defer source.Close()
	dir := t.TempDir()
	workingFile, err := os.Create(filepath.Join(dir, "song.mp3"))
	requireTestNoError(t, err)
	_, err = io.Copy(workingFile, source)
	requireTestNoError(t, err)
	requireTestNoError(t, workingFile.Close())
	info, err := source.Stat()
	requireTestNoError(t, err)
	trailer := make([]byte, 15)
	_, err = source.ReadAt(trailer, info.Size()-15)
	requireTestNoError(t, err)
	verifyMetadataTrailerSave(t, dir, trailer)
}

func verifyMetadataTrailerSave(t *testing.T, dir string, trailer []byte) {
	t.Helper()
	path := filepath.Join(dir, "song.mp3")
	packets := metadataPackets(t, path)
	files, ctx, epoch, ref := metadataTestService(t, dir)
	baseline := files.ReadMetadata(ctx, epoch, ref)
	requireTestEqual(t, baseline.Code, "ok")
	title := "附加数据保留验证"
	result := files.SaveMetadata(ctx, epoch, MetadataSaveRequest{
		OperationID: metadataTestNonce(t), Ref: ref, SHA256: baseline.SHA256,
		Patch: metadata.Patch{Title: &title},
	})
	requireTestEqual(t, result.Code, "ok")
	requireTestEqual(t, result.Committed, true)
	if result.Ref == nil {
		t.Fatal("missing updated reference")
	}
	reread := files.ReadMetadata(ctx, epoch, *result.Ref)
	requireTestEqual(t, reread.Code, "ok")
	if reread.Info == nil || reread.Info.Title != title {
		t.Fatalf("title was not saved: %+v", reread)
	}
	after, err := os.ReadFile(path)
	requireTestNoError(t, err)
	if !bytes.HasSuffix(after, trailer) {
		t.Fatal("original trailer changed")
	}
	if !bytes.Equal(packets, metadataPackets(t, path)) {
		t.Fatal("encoded audio packets changed")
	}
}
