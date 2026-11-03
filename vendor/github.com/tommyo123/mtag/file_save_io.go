package mtag

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tommyo123/mtag/id3v1"
)

var copyBufPool = sync.Pool{
	New: func() any { b := make([]byte, 1<<20); return &b },
}

func (f *File) createSiblingTemp() (*os.File, string, error) {
	if f.path == "" {
		return nil, "", errors.New("mtag: file has no path")
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.path), ".mtag-*")
	if err != nil {
		return nil, "", err
	}
	f.applyPathMode(tmp)
	copyPathXattrs(f.path, tmp.Name())
	return tmp, tmp.Name(), nil
}

func (f *File) pathModTime() time.Time {
	if f.path == "" {
		return time.Time{}
	}
	info, err := os.Stat(f.path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

func (f *File) applyPathMode(tmp *os.File) {
	if f.path == "" || tmp == nil {
		return
	}
	info, err := os.Stat(f.path)
	if err != nil {
		return
	}
	_ = tmp.Chmod(info.Mode())
}

func (f *File) applyPathModTime(path string, modTime time.Time) {
	if path == "" || modTime.IsZero() {
		return
	}
	_ = os.Chtimes(path, modTime, modTime)
}

// patchAt overwrites len(data) bytes starting at off. The file size
// does not change.
func (f *File) patchAt(off int64, data []byte) error {
	modTime := f.pathModTime()
	fd, err := f.writable()
	if err != nil {
		return err
	}
	_, err = fd.WriteAt(data, off)
	if err != nil {
		return err
	}
	f.applyPathModTime(f.path, modTime)
	return nil
}

// rewriteWithV2 re-emits the file with newTag prepended and the
// existing audio data copied across. Passing nil removes the ID3v2
// region entirely.
func (f *File) rewriteWithV2(newTag []byte) error {
	_, err := f.writable()
	if err != nil {
		return err
	}
	modTime := f.pathModTime()

	oldV2Size := f.v2size
	audioStart := oldV2Size
	audioEnd := f.size
	if f.v1 != nil && f.formatsOnDisk().Has(FormatID3v1) {
		audioEnd -= int64(id3v1.Size)
	}

	if f.path == "" {
		if err := f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if len(newTag) > 0 {
				if _, err := tmp.Write(newTag); err != nil {
					return err
				}
			}
			if audioEnd > audioStart {
				if err := copyRangeCtx(f.saveCtx, tmp, f.src, audioStart, audioEnd-audioStart); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
		f.adjustOffsetsAfterV2Rewrite(oldV2Size, int64(len(newTag)))
		return nil
	}

	tmp, tmpPath, err := f.createSiblingTemp()
	if err != nil {
		return err
	}
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if len(newTag) > 0 {
		if _, err := tmp.Write(newTag); err != nil {
			cleanup()
			return err
		}
	}

	if audioEnd > audioStart {
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, audioStart, audioEnd-audioStart); err != nil {
			cleanup()
			return err
		}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	if f.fd != nil {
		_ = f.fd.Close()
	}
	f.clearSourceHandles()

	if err := os.Rename(tmpPath, f.path); err != nil {
		if renameBlockedByReader(err) {
			if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
				f.adjustOffsetsAfterV2Rewrite(oldV2Size, int64(len(newTag)))
				return nil
			}
		}
		_ = os.Remove(tmpPath)
		_ = f.reopenPathWritable()
		return err
	}
	f.applyPathModTime(f.path, modTime)

	if err := f.reopenPathWritable(); err != nil {
		return err
	}
	f.adjustOffsetsAfterV2Rewrite(oldV2Size, int64(len(newTag)))
	return nil
}

func (f *File) adjustOffsetsAfterV2Rewrite(oldV2Size, newV2Size int64) {
	delta := newV2Size - oldV2Size
	f.v2size = newV2Size
	if delta == 0 || f.apeLen == 0 {
		return
	}
	if f.apeAt >= oldV2Size {
		f.apeAt += delta
	}
}

func renameBlockedByReader(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "access is denied") ||
		strings.Contains(s, "being used by another process")
}

func (f *File) replacePathFromTemp(tmpPath string) error {
	modTime := f.pathModTime()
	tmp, err := os.Open(tmpPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	info, err := tmp.Stat()
	if err != nil {
		return err
	}
	reopen, err := os.OpenFile(f.path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	if err := reopen.Truncate(0); err != nil {
		_ = reopen.Close()
		return err
	}
	if _, err := reopen.Seek(0, io.SeekStart); err != nil {
		_ = reopen.Close()
		return err
	}
	if _, err := io.Copy(reopen, tmp); err != nil {
		_ = reopen.Close()
		return err
	}
	if err := reopen.Truncate(info.Size()); err != nil {
		_ = reopen.Close()
		return err
	}
	if _, err := reopen.Seek(0, io.SeekStart); err != nil {
		_ = reopen.Close()
		return err
	}
	f.applyPathModTime(f.path, modTime)
	f.attachPathHandle(f.path, reopen, true, info.Size())
	return nil
}

// replaceWritableFromTemp streams the contents of tmpPath back into the
// current writable source without loading the whole rewritten file into
// memory. It is the non-path-backed counterpart to replacePathFromTemp.
func (f *File) replaceWritableFromTemp(tmpPath string) error {
	tmp, err := os.Open(tmpPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()
	info, err := tmp.Stat()
	if err != nil {
		return err
	}
	w, err := f.writable()
	if err != nil {
		return err
	}
	rollbackPath, rollbackSize, err := f.snapshotWritableSource()
	if err != nil {
		return err
	}
	defer func() {
		if rollbackPath != "" {
			_ = os.Remove(rollbackPath)
		}
	}()
	const chunk = 1 << 20
	buf := make([]byte, chunk)
	mutated := false
	for off := int64(0); off < info.Size(); {
		if err := f.checkCtx(); err != nil {
			if mutated {
				return f.rollbackWritableSource(w, rollbackPath, rollbackSize, err)
			}
			return err
		}
		n, err := tmp.ReadAt(buf, off)
		if n > 0 {
			if _, werr := w.WriteAt(buf[:n], off); werr != nil {
				return f.rollbackWritableSource(w, rollbackPath, rollbackSize, werr)
			}
			mutated = true
			off += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if mutated {
				return f.rollbackWritableSource(w, rollbackPath, rollbackSize, err)
			}
			return err
		}
	}
	if err := w.Truncate(info.Size()); err != nil {
		if mutated {
			return f.rollbackWritableSource(w, rollbackPath, rollbackSize, err)
		}
		return err
	}
	f.attachWritableSource(w, info.Size())
	return nil
}

func (f *File) snapshotWritableSource() (string, int64, error) {
	tmp, err := os.CreateTemp("", ".mtag-rollback-*")
	if err != nil {
		return "", 0, err
	}
	path := tmp.Name()
	size := f.size
	if size > 0 {
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, 0, size); err != nil {
			_ = tmp.Close()
			_ = os.Remove(path)
			return "", 0, err
		}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(path)
		return "", 0, err
	}
	return path, size, nil
}

func (f *File) rollbackWritableSource(w WritableSource, snapshotPath string, size int64, cause error) error {
	if snapshotPath == "" {
		return cause
	}
	restore, err := os.Open(snapshotPath)
	if err != nil {
		return fmt.Errorf("%w (rollback open failed: %v)", cause, err)
	}
	defer restore.Close()
	const chunk = 1 << 20
	buf := make([]byte, chunk)
	for off := int64(0); off < size; {
		n, err := restore.ReadAt(buf, off)
		if n > 0 {
			if _, werr := w.WriteAt(buf[:n], off); werr != nil {
				return fmt.Errorf("%w (rollback write failed: %v)", cause, werr)
			}
			off += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("%w (rollback read failed: %v)", cause, err)
		}
	}
	if err := w.Truncate(size); err != nil {
		return fmt.Errorf("%w (rollback truncate failed: %v)", cause, err)
	}
	f.attachWritableSource(w, size)
	return cause
}

// rewriteWritableFromTemp spills a rewritten file into a temp file
// and then streams it back into the current writable source. It is
// used by non-path-backed full-rewrite save flows to avoid holding
// the entire rebuilt file in memory.
func (f *File) rewriteWritableFromTemp(write func(*os.File) error) error {
	tmp, err := os.CreateTemp("", ".mtag-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if err := write(tmp); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return f.replaceWritableFromTemp(tmpPath)
}

func (f *File) reopenPathWritable() error {
	if f.path == "" {
		return errors.New("mtag: file is closed")
	}
	reopen, err := os.OpenFile(f.path, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrReadOnly, err)
	}
	info, err := reopen.Stat()
	if err != nil {
		_ = reopen.Close()
		return err
	}
	if f.fd != nil && f.fd != reopen {
		_ = f.fd.Close()
	}
	f.attachPathHandle(f.path, reopen, true, info.Size())
	return nil
}

// writable returns an RDWR handle, upgrading the current one if
// necessary.
func (f *File) writable() (WritableSource, error) {
	if f.rw != nil {
		return f.rw, nil
	}
	if f.forceReadOnly {
		return nil, ErrReadOnly
	}
	if f.fd == nil || f.path == "" {
		return nil, errors.New("mtag: file is closed")
	}
	if err := f.reopenPathWritable(); err != nil {
		return nil, err
	}
	return f.rw, nil
}

// copyRange copies length bytes from src starting at srcOff into dst
// at its current offset, in chunks to bound memory use.
func copyRange(dst io.Writer, src io.ReaderAt, srcOff, length int64) error {
	return copyRangeCtx(nil, dst, src, srcOff, length)
}

func copyRangeCtx(ctx context.Context, dst io.Writer, src io.ReaderAt, srcOff, length int64) error {
	const chunk = 1 << 20
	bp := copyBufPool.Get().(*[]byte)
	buf := *bp
	defer copyBufPool.Put(bp)
	remaining := length
	off := srcOff
	for remaining > 0 {
		if ctx != nil {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		n := int64(chunk)
		if n > remaining {
			n = remaining
		}
		got, err := src.ReadAt(buf[:n], off)
		if got > 0 {
			if _, werr := dst.Write(buf[:got]); werr != nil {
				return werr
			}
			off += int64(got)
			remaining -= int64(got)
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if got == 0 {
			return io.ErrUnexpectedEOF
		}
	}
	return nil
}

// replaceSource overwrites the writable source with the supplied
// bytes and truncates any old tail.
func (f *File) replaceSource(data []byte) error {
	w, err := f.writable()
	if err != nil {
		return err
	}
	const chunk = 1 << 20
	for off := 0; off < len(data); off += chunk {
		if err := f.checkCtx(); err != nil {
			return err
		}
		end := off + chunk
		if end > len(data) {
			end = len(data)
		}
		if _, err := w.WriteAt(data[off:end], int64(off)); err != nil {
			return err
		}
	}
	if err := w.Truncate(int64(len(data))); err != nil {
		return err
	}
	f.size = int64(len(data))
	f.attachWritableSource(w, int64(len(data)))
	return nil
}

// refreshAfterSave clears the cached views and re-detects the current
// source so the in-memory File mirrors the bytes just written.
func (f *File) refreshAfterSave() error {
	f.clearDetectedState()
	return f.detect()
}
