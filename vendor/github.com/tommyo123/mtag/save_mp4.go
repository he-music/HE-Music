package mtag

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"

	"github.com/tommyo123/mtag/mp4"
)

// ErrMP4NoRoom reports that an in-place `ilst` patch cannot fit the
// new body.
var ErrMP4NoRoom = errors.New("mtag: MP4 rewrite needs more bytes than the original ilst atom holds")

// saveMP4 writes the in-memory ilst items back to disk. An in-place
// patch is attempted first; when the new ilst body outgrows the
// original region, the file is rebuilt with stco/co64 offsets
// shifted to match and renamed atomically over the original.
func (f *File) saveMP4() error {
	if f.container.Kind() != ContainerMP4 {
		return fmt.Errorf("mtag: saveMP4 called on %v", f.container.Kind())
	}
	items := []mp4.Item{}
	if f.mp4 != nil {
		items = f.mp4.items
	}
	newILSTBody := mp4.EncodeILSTBody(items)
	var newChplBody []byte
	if f.chaptersDirty {
		newChplBody = mp4.EncodeChplBody(chaptersForMP4(f.chapters))
	}

	// Try the in-place patch first.
	if err := f.saveMP4InPlace(newILSTBody, newChplBody); err == nil {
		return nil
	} else if !errors.Is(err, ErrMP4NoRoom) {
		return err
	}
	// Fall back to a full rewrite when the new ilst body has
	// outgrown the original region.
	return f.saveMP4FullRewrite(newILSTBody, newChplBody)
}

// saveMP4InPlace is the original ilst-patch path. Returns
// [ErrMP4NoRoom] when the new body cannot fit in the existing
// region; the caller falls back to the full-rewrite path.
func (f *File) saveMP4InPlace(newBody, newChplBody []byte) error {
	if f.chaptersDirty {
		return ErrMP4NoRoom
	}
	_, ilstOffset, ilstSize, err := mp4.ReadItemsAt(f.src, f.size)
	if err != nil {
		return err
	}
	if ilstOffset == 0 && ilstSize == 0 {
		return fmt.Errorf("mtag: MP4 file has no ilst atom to patch")
	}
	const ilstHeader = 8
	availBody := int(ilstSize) - ilstHeader
	switch {
	case len(newBody) > availBody:
		return ErrMP4NoRoom
	case len(newBody) < availBody:
		spare := availBody - len(newBody)
		if spare < 8 {
			return ErrMP4NoRoom
		}
		free := make([]byte, spare)
		binary.BigEndian.PutUint32(free[0:4], uint32(spare))
		copy(free[4:8], []byte("free"))
		newBody = append(newBody, free...)
	}
	var hdr [ilstHeader]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(ilstSize))
	copy(hdr[4:8], []byte("ilst"))

	fd, err := f.writable()
	if err != nil {
		return err
	}
	if _, err := fd.WriteAt(hdr[:], ilstOffset); err != nil {
		return err
	}
	if _, err := fd.WriteAt(newBody, ilstOffset+ilstHeader); err != nil {
		return err
	}
	return nil
}

// saveMP4FullRewrite rebuilds the entire MP4 file with a new moov
// atom carrying the supplied ilst body. When mdat sits after moov,
// every stco / co64 entry inside moov is shifted by the size delta
// so sample-table references continue to point at the right bytes
// in the new file layout.
func (f *File) saveMP4FullRewrite(newILSTBody, newChplBody []byte) error {
	if f.path == "" {
		// In-memory writable sources don't support full rewrites
		// via temp + rename; fall back to a buffer rebuild.
		return f.saveMP4Buffered(newILSTBody, newChplBody)
	}
	atoms := mp4.WalkTopLevel(f.src, f.size)
	moovIdx, mdatIdx := indexOfTopAtom(atoms, "moov"), indexOfTopAtom(atoms, "mdat")
	if moovIdx < 0 {
		return fmt.Errorf("mtag: MP4 file has no moov atom")
	}

	// Pull the entire moov body into memory (typically a few KiB).
	oldMoov := atoms[moovIdx]
	moovBody := make([]byte, oldMoov.DataSize)
	if _, err := f.src.ReadAt(moovBody, oldMoov.DataAt); err != nil {
		return err
	}
	newMoovBody, err := mp4.RewriteMoovWithMetadata(moovBody, newILSTBody, newChplBody, f.chaptersDirty)
	if err != nil {
		return err
	}
	// Patch sample offsets if mdat moves with the moov size delta.
	delta := int64(8+len(newMoovBody)) - oldMoov.Size
	if mdatIdx > moovIdx && delta != 0 {
		mp4.PatchSampleOffsets(newMoovBody, delta)
	}

	// Stream the new file: every original top-level atom is
	// copied verbatim except moov, which is replaced.
	tmp, tmpPath, err := f.createSiblingTemp()
	if err != nil {
		return err
	}
	modTime := f.pathModTime()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	for i, a := range atoms {
		if i == moovIdx {
			var hdr [8]byte
			binary.BigEndian.PutUint32(hdr[0:4], uint32(8+len(newMoovBody)))
			copy(hdr[4:8], []byte("moov"))
			if _, err := tmp.Write(hdr[:]); err != nil {
				cleanup()
				return err
			}
			if _, err := tmp.Write(newMoovBody); err != nil {
				cleanup()
				return err
			}
			continue
		}
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, a.Offset, a.Size); err != nil {
			cleanup()
			return err
		}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	_ = f.fd.Close()
	f.fd = nil
	if err := os.Rename(tmpPath, f.path); err != nil {
		if renameBlockedByReader(err) {
			if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
				return nil
			}
		}
		_ = os.Remove(tmpPath)
		if reopen, rerr := os.OpenFile(f.path, os.O_RDWR, 0); rerr == nil {
			f.fd = reopen
			f.src = reopen
			f.rw = reopen
			f.openedRW = true
		}
		return err
	}
	f.applyPathModTime(f.path, modTime)
	reopen, err := os.OpenFile(f.path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	f.fd = reopen
	f.src = reopen
	f.rw = reopen
	f.openedRW = true
	if info, err := reopen.Stat(); err == nil {
		f.size = info.Size()
	}
	return nil
}

// saveMP4Buffered is the non-path-backed full-rewrite fallback. It
// spills the rebuilt file into a temp file and then streams it back
// into the caller's writable source.
func (f *File) saveMP4Buffered(newILSTBody, newChplBody []byte) error {
	atoms := mp4.WalkTopLevel(f.src, f.size)
	moovIdx, mdatIdx := indexOfTopAtom(atoms, "moov"), indexOfTopAtom(atoms, "mdat")
	if moovIdx < 0 {
		return fmt.Errorf("mtag: MP4 file has no moov atom")
	}
	oldMoov := atoms[moovIdx]
	moovBody := make([]byte, oldMoov.DataSize)
	if _, err := f.src.ReadAt(moovBody, oldMoov.DataAt); err != nil {
		return err
	}
	newMoovBody, err := mp4.RewriteMoovWithMetadata(moovBody, newILSTBody, newChplBody, f.chaptersDirty)
	if err != nil {
		return err
	}
	delta := int64(8+len(newMoovBody)) - oldMoov.Size
	if mdatIdx > moovIdx && delta != 0 {
		mp4.PatchSampleOffsets(newMoovBody, delta)
	}
	return f.rewriteWritableFromTemp(func(tmp *os.File) error {
		for i, a := range atoms {
			if i == moovIdx {
				var hdr [8]byte
				binary.BigEndian.PutUint32(hdr[0:4], uint32(8+len(newMoovBody)))
				copy(hdr[4:8], []byte("moov"))
				if _, err := tmp.Write(hdr[:]); err != nil {
					return err
				}
				if _, err := tmp.Write(newMoovBody); err != nil {
					return err
				}
				continue
			}
			if err := copyRangeCtx(f.saveCtx, tmp, f.src, a.Offset, a.Size); err != nil {
				return err
			}
		}
		return nil
	})
}

// indexOfTopAtom returns the index of the first top-level atom
// matching name, or -1 if absent.
func indexOfTopAtom(atoms []mp4.TopLevelAtom, name string) int {
	for i, a := range atoms {
		if string(a.Name[:]) == name {
			return i
		}
	}
	return -1
}
