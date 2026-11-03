package mtag

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxCAFInfoChunkBytes = 4 << 20

// cafView is the in-memory snapshot of a CAF "info" chunk.
type cafView struct {
	keys   []string
	values map[string]string
	// dirty flips to true the first time a caller mutates the view
	// via [Set]. The save path uses it to decide whether the info
	// chunk needs to be re-encoded at all.
	dirty bool
	// chunkAt is the absolute byte offset of the existing info
	// chunk header on disk, or -1 when the file carried no info
	// chunk when it was opened. Used by the save path to patch the
	// chunk in place when the new body fits exactly.
	chunkAt int64
	// chunkSize is the declared byte size of the existing info
	// chunk data region.
	chunkSize int64
}

// Get returns the value stored under key, using the spec's
// case-sensitive match (CAF keys are normally capitalised like
// "title", "artist", ...).
func (v *cafView) Get(key string) string {
	if v == nil {
		return ""
	}
	if s, ok := v.values[key]; ok {
		return s
	}
	// Tolerate case variants; some writers Capital-case keys.
	for k, val := range v.values {
		if strings.EqualFold(k, key) {
			return val
		}
	}
	return ""
}

// scanCAFInfo walks a CAF file looking for the "info" chunk and
// parses its NUL-terminated key/value pairs. Returns nil when no
// info chunk is found.
func scanCAFInfo(r io.ReaderAt, size int64) *cafView {
	if size < 8 {
		return nil
	}
	// CAF header: 4-byte "caff" magic + 2-byte BE version + 2-byte
	// BE flags. The first chunk starts at offset 8.
	var magic [4]byte
	if _, err := r.ReadAt(magic[:], 0); err != nil {
		return nil
	}
	if string(magic[:]) != "caff" {
		return nil
	}
	cursor := int64(8)
	for cursor+12 <= size {
		var hdr [12]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			return nil
		}
		chunkID := string(hdr[:4])
		chunkSize := int64(binary.BigEndian.Uint64(hdr[4:12]))
		dataStart := cursor + 12
		if chunkSize < 0 || dataStart+chunkSize > size {
			return nil
		}
		if chunkID == "info" {
			if chunkSize > maxCAFInfoChunkBytes {
				return nil
			}
			body := make([]byte, chunkSize)
			if _, err := r.ReadAt(body, dataStart); err != nil {
				return nil
			}
			v := parseCAFInfo(body)
			if v != nil {
				v.chunkAt = cursor
				v.chunkSize = chunkSize
			}
			return v
		}
		cursor = dataStart + chunkSize
	}
	return nil
}

// parseCAFInfo decodes the body of a CAF "info" chunk: a 4-byte BE
// entry count followed by (key \x00 value \x00) pairs.
func parseCAFInfo(body []byte) *cafView {
	if len(body) < 4 {
		return nil
	}
	count := binary.BigEndian.Uint32(body[:4])
	cur := 4
	out := &cafView{values: map[string]string{}}
	for i := uint32(0); i < count && cur < len(body); i++ {
		keyEnd := bytes.IndexByte(body[cur:], 0)
		if keyEnd < 0 {
			break
		}
		key := string(body[cur : cur+keyEnd])
		cur += keyEnd + 1
		if cur >= len(body) {
			break
		}
		valEnd := bytes.IndexByte(body[cur:], 0)
		if valEnd < 0 {
			break
		}
		value := string(body[cur : cur+valEnd])
		cur += valEnd + 1
		if _, seen := out.values[key]; !seen {
			out.keys = append(out.keys, key)
		}
		out.values[key] = value
	}
	if len(out.keys) == 0 {
		return nil
	}
	return out
}

// Set stores a value under key, or removes the entry when value is
// empty. Marks the view dirty so save knows to regenerate the info
// chunk.
func (v *cafView) Set(key, value string) {
	if v == nil {
		return
	}
	if v.values == nil {
		v.values = map[string]string{}
	}
	if value == "" {
		if _, seen := v.values[key]; seen {
			delete(v.values, key)
			for i, k := range v.keys {
				if k == key {
					v.keys = append(v.keys[:i], v.keys[i+1:]...)
					break
				}
			}
			v.dirty = true
		}
		return
	}
	if cur, seen := v.values[key]; !seen || cur != value {
		if !seen {
			v.keys = append(v.keys, key)
		}
		v.values[key] = value
		v.dirty = true
	}
}

// encodeInfoBody serialises the view back into the CAF "info" chunk
// body layout: 4-byte BE entry count + N pairs of (NUL-terminated
// key, NUL-terminated value).
func (v *cafView) encodeInfoBody() []byte {
	if v == nil || len(v.keys) == 0 {
		return nil
	}
	var out []byte
	count := uint32(len(v.keys))
	countBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(countBuf, count)
	out = append(out, countBuf...)
	for _, k := range v.keys {
		out = append(out, []byte(k)...)
		out = append(out, 0)
		out = append(out, []byte(v.values[k])...)
		out = append(out, 0)
	}
	return out
}

// saveCAF writes cafView back to disk. If nothing changed it returns.
// Otherwise it patches the existing info chunk in place when the new
// body fits exactly, and falls back to a full rewrite.
func (f *File) saveCAF() error {
	if f.caf == nil || !f.caf.dirty {
		return nil
	}
	newBody := f.caf.encodeInfoBody()
	w, err := f.writable()
	if err != nil {
		return err
	}

	// Fast path: info chunk exists and the new body is exactly the
	// same size — patch in place, no file size change.
	if f.caf.chunkAt > 0 && int64(len(newBody)) == f.caf.chunkSize {
		if _, err := w.WriteAt(newBody, f.caf.chunkAt+12); err != nil {
			return err
		}
		f.caf.dirty = false
		return nil
	}

	// Full rewrite: stream every chunk in order into a temp file,
	// skip the old info chunk, then append a fresh one at the tail.
	tempDir := ""
	if f.path != "" {
		tempDir = filepath.Dir(f.path)
	}
	var tmp *os.File
	var tmpPath string
	if f.path != "" {
		tmp, tmpPath, err = f.createSiblingTemp()
	} else {
		tmp, err = os.CreateTemp(tempDir, ".mtag-*")
		if err == nil {
			tmpPath = tmp.Name()
		}
	}
	if err != nil {
		return err
	}
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	var head [8]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(head[:]); err != nil {
		cleanup()
		return err
	}
	outSize := int64(len(head))

	cursor := int64(8)
	for cursor+12 <= f.size {
		if err := f.checkCtx(); err != nil {
			cleanup()
			return err
		}
		var hdr [12]byte
		if _, err := f.src.ReadAt(hdr[:], cursor); err != nil {
			cleanup()
			return err
		}
		chunkID := string(hdr[:4])
		chunkSize := int64(binary.BigEndian.Uint64(hdr[4:12]))
		dataStart := cursor + 12
		if chunkSize < 0 || dataStart+chunkSize > f.size {
			cleanup()
			return fmt.Errorf("mtag: malformed CAF chunk %q at %d", chunkID, cursor)
		}
		if chunkID == "info" {
			// Drop the old info chunk; we re-emit later.
			cursor = dataStart + chunkSize
			continue
		}
		if _, err := tmp.Write(hdr[:]); err != nil {
			cleanup()
			return err
		}
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, dataStart, chunkSize); err != nil {
			cleanup()
			return err
		}
		outSize += 12 + chunkSize
		cursor = dataStart + chunkSize
	}
	// Append the fresh info chunk.
	infoAt := int64(-1)
	if len(newBody) > 0 {
		var infoHdr [12]byte
		copy(infoHdr[:4], []byte("info"))
		binary.BigEndian.PutUint64(infoHdr[4:12], uint64(len(newBody)))
		infoAt = outSize
		if _, err := tmp.Write(infoHdr[:]); err != nil {
			cleanup()
			return err
		}
		if _, err := tmp.Write(newBody); err != nil {
			cleanup()
			return err
		}
		outSize += 12 + int64(len(newBody))
	}

	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	if f.path == "" {
		if err := f.replaceWritableFromTemp(tmpPath); err != nil {
			return err
		}
	} else {
		modTime := f.pathModTime()
		if f.fd != nil {
			_ = f.fd.Close()
		}
		f.clearSourceHandles()
		if err := os.Rename(tmpPath, f.path); err != nil {
			if renameBlockedByReader(err) {
				if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
					goto saved
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
	}

saved:
	f.size = outSize
	f.caf.chunkAt = infoAt
	f.caf.chunkSize = int64(len(newBody))
	f.caf.dirty = false
	return nil
}

// cafTagView adapts a [cafView] to the polymorphic [Tag] interface.
type cafTagView struct{ v *cafView }

func (v *cafTagView) Kind() TagKind          { return TagCAF }
func (v *cafTagView) Keys() []string         { return append([]string{}, v.v.keys...) }
func (v *cafTagView) Get(name string) string { return v.v.Get(name) }

// cafFieldFor maps an ID3v2 canonical frame ID to the CAF info key
// convention. CAF uses lower-case English names with no prefix.
func cafFieldFor(frameID string) string {
	switch frameID {
	case "TIT2":
		return "title"
	case "TPE1":
		return "artist"
	case "TALB":
		return "album"
	case "TCOM":
		return "composer"
	case "TYER", "TDRC":
		return "year"
	case "TRCK":
		return "track number"
	case "TCON":
		return "genre"
	case "COMM":
		return "comments"
	case "TCOP":
		return "copyright"
	case "TENC":
		return "encoding application"
	}
	return ""
}
