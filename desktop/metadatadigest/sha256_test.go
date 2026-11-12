package metadatadigest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"testing"
)

func TestSHA256MatchesSourceAndPreservesOffset(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "baseline")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data := bytes.Repeat([]byte("baseline\x00\xff"), 10000)
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Seek(7, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	baseline, err := SHA256(t.Context(), file)
	if err != nil {
		t.Fatal(err)
	}
	both, err := Source(t.Context(), file)
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256(data)
	if baseline != hex.EncodeToString(expected[:]) || baseline != both.SHA256 || len(both.MD5) != 32 {
		t.Fatalf("baseline=%s both=%+v", baseline, both)
	}
	only, err := source(t.Context(), file, false)
	if err != nil || only.MD5 != "" || only.SHA256 != baseline {
		t.Fatalf("unexpected optional digest: %+v %v", only, err)
	}
	if offset, err := file.Seek(0, io.SeekCurrent); err != nil || offset != 7 {
		t.Fatalf("file offset changed: %d %v", offset, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if got, err := SHA256(ctx, file); got != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel leaked digest: %q %v", got, err)
	}
	if err := file.Truncate(0); err != nil {
		t.Fatal(err)
	}
	if _, err := SHA256(t.Context(), file); !errors.Is(err, ErrEmpty) {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := SHA256(t.Context(), file); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed file error lost: %v", err)
	}
}
