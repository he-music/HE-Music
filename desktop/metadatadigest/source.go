// Package metadatadigest computes the metadata baseline and legacy online match key.
package metadatadigest

import (
	"context"
	"crypto/md5" // Legacy search/match compatibility only; never used for authentication.
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

var ErrEmpty = errors.New("empty metadata source")
var ErrChanged = errors.New("metadata source changed")

type Result struct {
	SHA256 string
	MD5    string
}

// Source reads both digests in one pass with constant memory, regardless of file size.
// The caller owns grant/ref validation, identity locking and final lease validation.
func Source(ctx context.Context, file *os.File) (Result, error) {
	before, err := file.Stat()
	if err != nil {
		return Result{}, err
	}
	if before.Size() <= 0 {
		return Result{}, ErrEmpty
	}
	sha, match := sha256.New(), md5.New()
	buffer := make([]byte, 32<<10)
	for offset := int64(0); offset < before.Size(); {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		size := min(int64(len(buffer)), before.Size()-offset)
		n, err := file.ReadAt(buffer[:size], offset)
		if n != int(size) {
			return Result{}, io.ErrUnexpectedEOF
		}
		if err != nil && err != io.EOF {
			return Result{}, err
		}
		sha.Write(buffer[:n])
		match.Write(buffer[:n])
		offset += int64(n)
	}
	after, err := file.Stat()
	if err != nil {
		return Result{}, err
	}
	if !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || before.Mode() != after.Mode() {
		return Result{}, ErrChanged
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	return Result{SHA256: hex.EncodeToString(sha.Sum(nil)), MD5: hex.EncodeToString(match.Sum(nil))}, nil
}
