package mtag

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// detectSingleV2 is the generic "wrapper points at one embedded
// ID3v2 region" path used by DSF and DFF. Unlike bare MP3 there is
// no prepended-tag chain or trailing v1 footer to walk.
func (f *File) detectSingleV2(cfg openConfig) error {
	info := f.container.info()
	if cfg.skipV2 || info.v2Offset < 0 {
		return nil
	}
	return f.detectV2InRange(info.v2Offset, info.v2Bound)
}

func scanDSFContainer(r io.ReaderAt, size int64) containerInfo {
	info := containerInfo{kind: ContainerDSF, v2Offset: -1}
	if size < 28 {
		return info
	}
	var head [28]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return info
	}
	if string(head[:4]) != "DSD " {
		return info
	}
	metaAt := int64(binary.LittleEndian.Uint64(head[20:28]))
	if metaAt <= 0 || metaAt >= size {
		return info
	}
	info.v2Offset = metaAt
	info.v2Bound = size - metaAt
	return info
}

func scanDFFContainer(r io.ReaderAt, size int64) containerInfo {
	info := containerInfo{kind: ContainerDFF, v2Offset: -1, v2ChunkAt: -1}
	const chunkHeader = 12
	cursor := int64(16) // FRM8 header (12) + 4-byte form type ("DSD ")
	for cursor+chunkHeader <= size {
		var hdr [chunkHeader]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			return info
		}
		dataSize := int64(binary.BigEndian.Uint64(hdr[4:12]))
		dataAt := cursor + chunkHeader
		if dataSize < 0 || dataAt+dataSize > size {
			return info
		}
		if string(hdr[:4]) == "ID3 " {
			info.v2Offset = dataAt
			info.v2Bound = dataSize
			info.v2ChunkAt = cursor
			copy(info.v2ChunkID[:], hdr[:4])
			return info
		}
		if dataSize%2 == 1 {
			dataSize++
		}
		cursor = dataAt + dataSize
	}
	return info
}

// saveDSF rewrites or strips the trailing ID3v2 region referenced by
// the 28-byte DSF file header. The audio payload itself is left
// untouched; only the suffix and the header's file-size / metadata
// pointer fields change.
func (f *File) saveDSF() error {
	info := f.container.info()
	tagAt := f.size
	if info.v2Offset >= 0 && info.v2Offset < tagAt {
		tagAt = info.v2Offset
	}
	w, err := f.writable()
	if err != nil {
		return err
	}

	var newTag []byte
	if f.v2 != nil {
		body, err := f.v2.Encode(0)
		if err != nil {
			return err
		}
		if info.v2Offset >= 0 && f.v2size > 0 && int64(len(body)) <= f.v2size {
			padded, err := f.v2.Encode(int(f.v2size - int64(len(body))))
			if err != nil {
				return err
			}
			if err := f.patchAt(info.v2Offset, padded); err != nil {
				return err
			}
			return patchDSFHeader(w, f.size, info.v2Offset)
		}
		padded, err := f.v2.Encode(int(f.paddingBudgetOr(defaultPadding)))
		if err != nil {
			return err
		}
		newTag = padded
	}

	if err := w.Truncate(tagAt); err != nil {
		return err
	}
	if len(newTag) > 0 {
		if _, err := w.WriteAt(newTag, tagAt); err != nil {
			return err
		}
	}
	newSize := tagAt + int64(len(newTag))
	metaAt := int64(0)
	if len(newTag) > 0 {
		metaAt = tagAt
	}
	if err := patchDSFHeader(w, newSize, metaAt); err != nil {
		return err
	}
	f.size = newSize
	f.v2size = int64(len(newTag))
	return nil
}

func patchDSFHeader(w WritableSource, fileSize, metaAt int64) error {
	var hdr [16]byte
	binary.LittleEndian.PutUint64(hdr[0:8], uint64(fileSize))
	binary.LittleEndian.PutUint64(hdr[8:16], uint64(metaAt))
	_, err := w.WriteAt(hdr[:], 12)
	return err
}

// saveDFF rewrites or strips the embedded "ID3 " chunk inside a
// DSDIFF container. A trailing ID3 chunk is truncated and re-emitted
// in place; a non-trailing one forces a full chunk-list rebuild.
// The 8-byte big-endian FRM8 size field is patched to match.
func (f *File) saveDFF() error {
	info := f.container.info()

	w, err := f.writable()
	if err != nil {
		return err
	}

	var tagBody []byte
	if f.v2 != nil {
		body, err := f.v2.Encode(0)
		if err != nil {
			return err
		}
		tagBody = body
	}

	// Fast path: existing chunk can absorb the new tag with padding,
	// no file size change required.
	if info.v2ChunkAt >= 0 && len(tagBody) > 0 && f.v2size > 0 && int64(len(tagBody)) <= f.v2size {
		padded, err := f.v2.Encode(int(f.v2size - int64(len(tagBody))))
		if err != nil {
			return err
		}
		if err := f.patchAt(info.v2Offset, padded); err != nil {
			return err
		}
		return nil
	}

	// Trailing-chunk rewrite. Truncate at the existing chunk header
	// (or EOF if none) and emit a fresh {"ID3 ", size, body, pad}
	// chunk at the tail.
	trailing := info.v2ChunkAt < 0
	if info.v2ChunkAt >= 0 {
		paddedSize := f.v2size
		if paddedSize%2 == 1 {
			paddedSize++
		}
		trailing = info.v2ChunkAt+12+paddedSize == f.size
	}
	if trailing {
		truncAt := f.size
		if info.v2ChunkAt >= 0 {
			truncAt = info.v2ChunkAt
		}
		if err := w.Truncate(truncAt); err != nil {
			return err
		}
		newSize := truncAt
		if len(tagBody) > 0 {
			var hdr [12]byte
			copy(hdr[:4], []byte("ID3 "))
			binary.BigEndian.PutUint64(hdr[4:12], uint64(len(tagBody)))
			if _, err := w.WriteAt(hdr[:], newSize); err != nil {
				return err
			}
			newSize += 12
			if _, err := w.WriteAt(tagBody, newSize); err != nil {
				return err
			}
			newSize += int64(len(tagBody))
			if len(tagBody)%2 == 1 {
				if _, err := w.WriteAt([]byte{0}, newSize); err != nil {
					return err
				}
				newSize++
			}
		}
		// Patch the FRM8 body size (BE 64-bit at offset 4). Per the
		// DSDIFF spec this covers everything after the 12-byte
		// FRM8 header.
		var sz [8]byte
		binary.BigEndian.PutUint64(sz[:], uint64(newSize-12))
		if _, err := w.WriteAt(sz[:], 4); err != nil {
			return err
		}
		f.size = newSize
		if len(tagBody) > 0 {
			f.v2size = int64(len(tagBody))
		} else {
			f.v2size = 0
		}
		return nil
	}

	// Non-trailing ID3: rebuild the chunk list into a temp buffer,
	// dropping the old ID3 chunk and appending the replacement at
	// the tail. FRM8 header (12 bytes) and the 4-byte "DSD " form
	// type stay in place; individual chunk headers are copied over.
	return f.rewriteDFFChunks(w, tagBody)
}

// rewriteDFFChunks handles the non-trailing-ID3 case by walking the
// original FRM8 chunk list, skipping the old ID3 chunk, and
// appending the rewritten tag at the tail of the new layout.
func (f *File) rewriteDFFChunks(w WritableSource, tagBody []byte) error {
	const header = 16 // FRM8 (4) + BE64 size (8) + form type (4)
	if f.size < header {
		return fmt.Errorf("mtag: DFF shorter than FRM8 header")
	}
	var total int64
	tagAt := int64(0)
	write := func(dst io.Writer) error {
		head := make([]byte, header)
		if _, err := f.src.ReadAt(head, 0); err != nil {
			return err
		}
		if _, err := dst.Write(head); err != nil {
			return err
		}
		total = header
		cursor := int64(header)
		for cursor+12 <= f.size {
			var hdr [12]byte
			if _, err := f.src.ReadAt(hdr[:], cursor); err != nil {
				return err
			}
			chunkID := string(hdr[:4])
			chunkSize := int64(binary.BigEndian.Uint64(hdr[4:12]))
			dataStart := cursor + 12
			if chunkSize < 0 || dataStart+chunkSize > f.size {
				return fmt.Errorf("mtag: malformed DFF chunk %q at %d", chunkID, cursor)
			}
			padded := chunkSize
			if padded%2 == 1 {
				padded++
			}
			if chunkID == "ID3 " {
				cursor = dataStart + padded
				continue
			}
			if _, err := dst.Write(hdr[:]); err != nil {
				return err
			}
			total += 12
			if err := copyRangeCtx(f.saveCtx, dst, f.src, dataStart, padded); err != nil {
				return err
			}
			total += padded
			cursor = dataStart + padded
		}
		if len(tagBody) > 0 {
			var hdr [12]byte
			copy(hdr[:4], []byte("ID3 "))
			binary.BigEndian.PutUint64(hdr[4:12], uint64(len(tagBody)))
			if _, err := dst.Write(hdr[:]); err != nil {
				return err
			}
			total += 12
			tagAt = total
			if _, err := dst.Write(tagBody); err != nil {
				return err
			}
			total += int64(len(tagBody))
			if len(tagBody)%2 == 1 {
				if _, err := dst.Write([]byte{0}); err != nil {
					return err
				}
				total++
			}
		}
		return nil
	}
	patchFRM8Size := func(tmp *os.File) error {
		if _, err := tmp.Seek(4, io.SeekStart); err != nil {
			return err
		}
		var sz [8]byte
		binary.BigEndian.PutUint64(sz[:], uint64(total-12))
		_, err := tmp.Write(sz[:])
		return err
	}

	if f.path == "" {
		if err := f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if err := write(tmp); err != nil {
				return err
			}
			return patchFRM8Size(tmp)
		}); err != nil {
			return err
		}
		f.v2size = int64(len(tagBody))
		f.v2at = tagAt
		return nil
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
	if err := write(tmp); err != nil {
		cleanup()
		return err
	}
	if err := patchFRM8Size(tmp); err != nil {
		cleanup()
		return err
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
				f.v2size = int64(len(tagBody))
				f.v2at = tagAt
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
	f.v2size = int64(len(tagBody))
	f.v2at = tagAt
	return nil
}
