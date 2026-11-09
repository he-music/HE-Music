package metadata

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func compareMetadata(t *testing.T, before, after []byte) error {
	t.Helper()
	return CompareMetadataPayload(t.Context(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after)))
}

func TestMetadataPreservesOpaqueTrailers(t *testing.T) {
	// Includes sync-like bytes: a trailer must not be scanned for a guessed codec.
	trailer := []byte{0xf0, 0, 0xff, 0x0f, 0x44, 0x44, 0x40, 0x48, 0x46, 0x3c, 0x36, 0x0e, 0x55, 0xff, 0xf0}
	for _, suffix := range []string{"flac", "mp3", "wav", "aiff", "aif", "aac", "m4a", "mp4", "ogg", "webm", "ape", "dff"} {
		t.Run(suffix, func(t *testing.T) {
			var path string
			switch suffix {
			case "flac":
				path = fixture(t, "flac", "")
			case "mp3":
				path = fixture(t, "mp3", "3")
			case "ape", "dff":
				path = filepath.Join(t.TempDir(), "synthetic."+suffix)
				data := formatsMACFixture()
				if suffix == "dff" {
					data = dffTestFixture(false)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			default:
				path = formatsFixture(t, suffix)
			}
			before := append(mustRead(t, path), trailer...)
			if err := os.WriteFile(path, before, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := compareMetadata(t, before, before); err != nil {
				t.Fatalf("existing trailer rejected: %v", err)
			}
			for _, title := range []string{"编辑标题", strings.Repeat("较长标题", 3000), "短标题"} {
				edit(t, path, Patch{Title: &title})
				after := mustRead(t, path)
				if got := readInfo(t, path, false).Title; got != title {
					t.Fatalf("title=%q", got)
				}
				trailerEnd := len(after)
				if suffix == "ape" || suffix == "mp3" || suffix == "aac" {
					_, end, err := formatRawBounds(payloadSource{t.Context(), bytes.NewReader(after), int64(len(after))})
					if err != nil {
						t.Fatal(err)
					}
					trailerEnd = int(end)
				}
				if !bytes.HasSuffix(after[:trailerEnd], trailer) {
					t.Fatal("original trailer was lost or changed")
				}
				if err := compareMetadata(t, before, after); err != nil {
					t.Fatalf("tag edit rejected: %v", err)
				}
				changed := bytes.Clone(after)
				changed[trailerEnd-1] ^= 1
				if err := compareMetadata(t, before, changed); !errors.Is(err, ErrAudioPayloadChanged) {
					t.Fatalf("changed trailer: %v", err)
				}
				removed := append(bytes.Clone(after[:trailerEnd-len(trailer)]), after[trailerEnd:]...)
				if err := compareMetadata(t, before, removed); !errors.Is(err, ErrAudioPayloadChanged) {
					t.Fatalf("removed trailer: %v", err)
				}
			}
		})
	}
}

func TestMetadataFLACStillProtectsAudioAndStreamInfo(t *testing.T) {
	before := append(payloadFLAC(), 1, 2, 3)
	for _, offset := range []int{8, 18, 26, 42, len(before) - 4} {
		after := bytes.Clone(before)
		after[offset] ^= 1
		if err := compareMetadata(t, before, after); err == nil {
			t.Fatalf("change at %d accepted", offset)
		}
	}
	if err := payloadCompare(before, before); err == nil {
		t.Fatal("download validation must still reject trailing FLAC bytes")
	}
}

func TestMetadataPreservationBoundsAndCancellation(t *testing.T) {
	flac := append(payloadFLAC(), bytes.Repeat([]byte{0x55}, 100_000)...)
	for _, size := range []int64{-1, 0, int64(len(flac) + 1)} {
		if err := CompareMetadataPayload(t.Context(), bytes.NewReader(flac), size, bytes.NewReader(flac), size); err == nil {
			t.Fatalf("invalid declared size %d accepted", size)
		}
	}
	if err := CompareMetadataPayload(t.Context(), nil, 1, bytes.NewReader(flac), int64(len(flac))); err == nil {
		t.Fatal("nil reader accepted")
	}
	measured := &payloadGuardReader{data: flac}
	if err := CompareMetadataPayload(t.Context(), measured, int64(len(flac)), bytes.NewReader(flac), int64(len(flac))); err != nil {
		t.Fatal(err)
	}
	if measured.maxRead > 32768 {
		t.Fatal("unbounded read")
	}
	for at := 1; at <= measured.calls; at++ {
		ctx, cancel := context.WithCancel(t.Context())
		source := &payloadGuardReader{data: flac, cancelAt: at, cancel: cancel}
		err := CompareMetadataPayload(ctx, source, int64(len(flac)), bytes.NewReader(flac), int64(len(flac)))
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read %d: %v", at, err)
		}
	}
}
