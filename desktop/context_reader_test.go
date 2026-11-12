package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

type cancelingReaderAt struct {
	reader io.ReaderAt
	cancel context.CancelFunc
}

func (r cancelingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := r.reader.ReadAt(p, off)
	r.cancel()
	return n, err
}

func TestContextReaderAt(t *testing.T) {
	data := []byte("audio")
	reader := contextReaderAt{t.Context(), bytes.NewReader(data)}
	buf := make([]byte, 4)
	if n, err := reader.ReadAt(buf, 2); n != 3 || !errors.Is(err, io.EOF) || string(buf[:n]) != "dio" {
		t.Fatalf("count/offset/error lost: n=%d err=%v data=%q", n, err, buf)
	}
	ctx, cancel := context.WithCancel(t.Context())
	reader = contextReaderAt{ctx, cancelingReaderAt{bytes.NewReader(data), cancel}}
	if n, err := reader.ReadAt(buf, 0); n != 4 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel after read: n=%d err=%v", n, err)
	}
	// A pre-canceled read must not consult even a nil underlying reader.
	reader.reader = nil
	if n, err := reader.ReadAt(buf, 0); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel before read: n=%d err=%v", n, err)
	}
}
