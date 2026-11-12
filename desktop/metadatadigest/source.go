// Package metadatadigest computes the metadata baseline and legacy online match key.
package metadatadigest

import (
	"context"
	"crypto/md5" // Legacy search/match compatibility only; never used for authentication.
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
)

var (
	ErrEmpty   = errors.New("empty metadata source")
	ErrChanged = errors.New("metadata source changed")
)

type Result struct {
	SHA256 string
	MD5    string
}

// Source reads both digests in one pass with constant memory, regardless of file size.
// The caller owns grant/ref validation, identity locking and final lease validation.
func Source(ctx context.Context, file *os.File) (Result, error) {
	return source(ctx, file, true)
}

// SHA256 computes only the metadata baseline, without the legacy match digest.
// It performs the same file status checks as Source and preserves the file offset.
func SHA256(ctx context.Context, file *os.File) (string, error) {
	result, err := source(ctx, file, false)
	return result.SHA256, err
}

func source(ctx context.Context, file *os.File, includeMD5 bool) (Result, error) {
	before, err := file.Stat()
	if err != nil {
		return Result{}, err
	}
	if before.Size() <= 0 {
		return Result{}, ErrEmpty
	}
	sha := sha256.New()
	var match hash.Hash
	if includeMD5 {
		match = md5.New()
	}
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
		if err != nil && !errors.Is(err, io.EOF) {
			return Result{}, err
		}
		sha.Write(buffer[:n])
		if match != nil {
			match.Write(buffer[:n])
		}
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
	result := Result{SHA256: hex.EncodeToString(sha.Sum(nil))}
	if match != nil {
		result.MD5 = hex.EncodeToString(match.Sum(nil))
	}
	return result, nil
}
