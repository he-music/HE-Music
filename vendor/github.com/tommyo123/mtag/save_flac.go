package mtag

import (
	"bytes"
	"fmt"
	"os"

	"github.com/tommyo123/mtag/flac"
)

// flacPaddingDefault is how much zero-byte FLAC PADDING block we
// emit at the tail of the metadata region after a save. It gives
// the next save room to grow without forcing another full
// audio-shift rewrite.
const flacPaddingDefault = 4096

// saveFLAC rewrites the on-disk FLAC file with the in-memory
// Vorbis Comments and PICTURE blocks. Other metadata blocks
// (STREAMINFO, SEEKTABLE, CUESHEET, APPLICATION) are preserved in
// their original order and bytes; old VORBIS_COMMENT, PICTURE and
// PADDING blocks are dropped and rebuilt from the in-memory view.
//
// A fast path patches the metadata region in place when the new
// block list fits inside the original (with a PADDING block
// absorbing any leftover bytes); otherwise the save streams
// through a sibling temp file and ends with an atomic rename.
func (f *File) saveFLAC() error {
	if f.container.Kind() != ContainerFLAC {
		return fmt.Errorf("mtag: saveFLAC called on %v", f.container.Kind())
	}

	blocks, audioStart, err := flac.ReadBlocks(f.src, f.size)
	if err != nil {
		return fmt.Errorf("mtag: re-read FLAC blocks: %w", err)
	}

	// Build the new block list. Preserve every block whose type
	// we don't manage, then append our managed blocks (Vorbis
	// Comment + PICTUREs).
	view := f.flac
	if view == nil {
		view = &flacView{}
	}

	var out []flac.Block
	for _, b := range blocks {
		switch b.Type {
		case flac.BlockVorbisComment, flac.BlockPicture, flac.BlockPadding:
			continue
		}
		out = append(out, flac.Block{Type: b.Type, Body: b.Body})
	}
	if view.comment != nil {
		out = append(out, flac.Block{
			Type: flac.BlockVorbisComment,
			Body: flac.EncodeVorbisComment(view.comment),
		})
	}
	for _, p := range view.pictures {
		out = append(out, flac.Block{
			Type: flac.BlockPicture,
			Body: flac.EncodePicture(p),
		})
	}

	// Fast path: if the managed blocks fit inside the original
	// metadata region (oldMetaLen = magic..audioStart) with room for
	// at least a 4-byte PADDING header, patch the metadata in place
	// and leave the audio bytes untouched.
	oldMetaLen := audioStart - int64(len(flac.Magic))
	var newMetaLen int64
	for _, b := range out {
		newMetaLen += 4 + int64(len(b.Body))
	}
	if f.rw != nil && f.path != "" && oldMetaLen >= newMetaLen+4 {
		padBody := int(oldMetaLen - newMetaLen - 4)
		inplace := append([]flac.Block(nil), out...)
		inplace = append(inplace, flac.Block{
			Type: flac.BlockPadding,
			Body: make([]byte, padBody),
		})
		for i := range inplace {
			inplace[i].IsLast = false
		}
		inplace[len(inplace)-1].IsLast = true
		var buf bytes.Buffer
		for _, b := range inplace {
			if err := flac.WriteBlock(&buf, b); err != nil {
				return err
			}
		}
		if int64(buf.Len()) == oldMetaLen {
			if _, err := f.rw.WriteAt(buf.Bytes(), int64(len(flac.Magic))); err != nil {
				return err
			}
			return nil
		}
	}

	// Full rewrite path: seed a default PADDING block so the next
	// save still has room to grow in place.
	out = append(out, flac.Block{
		Type: flac.BlockPadding,
		Body: make([]byte, f.paddingBudgetOr(flacPaddingDefault)),
	})
	for i := range out {
		out[i].IsLast = false
	}
	out[len(out)-1].IsLast = true

	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if _, err := tmp.Write(flac.Magic[:]); err != nil {
				return err
			}
			for _, b := range out {
				if err := flac.WriteBlock(tmp, b); err != nil {
					return err
				}
			}
			audioLen := f.size - audioStart
			if audioLen > 0 {
				if err := copyRangeCtx(f.saveCtx, tmp, f.src, audioStart, audioLen); err != nil {
					return err
				}
			}
			return nil
		})
	}

	tmp, tmpPath, err := f.createSiblingTemp()
	if err != nil {
		return err
	}
	modTime := f.pathModTime()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.Write(flac.Magic[:]); err != nil {
		cleanup()
		return err
	}
	for _, b := range out {
		if err := flac.WriteBlock(tmp, b); err != nil {
			cleanup()
			return err
		}
	}
	// Audio: copy verbatim from the source.
	audioLen := f.size - audioStart
	if audioLen > 0 {
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, audioStart, audioLen); err != nil {
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
	info, err := reopen.Stat()
	if err != nil {
		return err
	}
	f.size = info.Size()
	return nil
}
