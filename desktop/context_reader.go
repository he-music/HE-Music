package main

import (
	"context"
	"io"
)

// contextReaderAt preserves the underlying count and checks cancellation on both
// sides of each read. The underlying ReaderAt must itself return from ReadAt.
type contextReaderAt struct {
	ctx    context.Context
	reader io.ReaderAt
}

func (r contextReaderAt) ReadAt(p []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.ReadAt(p, offset)
	if canceled := r.ctx.Err(); canceled != nil {
		return n, canceled
	}
	return n, err
}
