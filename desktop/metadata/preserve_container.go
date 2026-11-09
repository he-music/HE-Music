package metadata

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

// Only separate trailers at an established container boundary. A malformed chunk
// within that boundary remains an error, rather than becoming dispensable data.
func metadataContainerEnd(s payloadSource) (int64, error) {
	kind, err := additionalPayloadKind(s)
	if err != nil {
		return 0, err
	}
	var header [16]byte
	switch kind {
	case "wave", "aiff", "dff":
		if err := s.read(0, header[:]); err != nil {
			return 0, err
		}
		var size uint64
		switch {
		case kind == "dff":
			size = binary.BigEndian.Uint64(header[4:12])
			if size > uint64(s.size-12) {
				return 0, ErrInvalidPayload
			}
			size += 12
		case kind == "aiff":
			size = uint64(binary.BigEndian.Uint32(header[4:8])) + 8
		case string(header[:4]) == "RIFF":
			size = uint64(binary.LittleEndian.Uint32(header[4:8])) + 8
		default:
			var extended [16]byte
			if err := s.read(12, extended[:]); err != nil {
				return 0, err
			}
			if string(extended[:4]) != "ds64" {
				return 0, ErrInvalidPayload
			}
			size = binary.LittleEndian.Uint64(extended[8:])
			if size > uint64(s.size-8) {
				return 0, ErrInvalidPayload
			}
			size += 8
		}
		if size < 12 || size > uint64(s.size) {
			return 0, ErrInvalidPayload
		}
		return int64(size), nil
	case "ogg":
		return metadataOggEnd(s)
	case "webm":
		return metadataWebMEnd(s)
	case "mp4":
		return metadataMP4End(s)
	default:
		return s.size, nil
	}
}

func metadataOggEnd(s payloadSource) (int64, error) {
	for off := int64(0); off < s.size; {
		var header [27]byte
		if err := s.read(off, header[:]); err != nil {
			return 0, err
		}
		if string(header[:4]) != "OggS" {
			return 0, ErrInvalidPayload
		}
		var laces [255]byte
		count := int(header[26])
		if err := s.read(off+27, laces[:count]); err != nil {
			return 0, err
		}
		end := off + 27 + int64(count)
		for _, size := range laces[:count] {
			end += int64(size)
		}
		if end > s.size {
			return 0, ErrInvalidPayload
		}
		if header[5]&4 != 0 {
			if err := rejectChainedTrailer(s, end, []byte("OggS")); err != nil {
				return 0, err
			}
			return end, nil
		}
		off = end
	}
	return 0, ErrInvalidPayload
}

func metadataWebMEnd(s payloadSource) (int64, error) {
	for off := int64(0); off < s.size; {
		id, _, next, open, err := formatEBMLElement(s, off, s.size)
		if err != nil {
			return 0, err
		}
		if off == 0 && (id != 0x1a45dfa3 || open) {
			return 0, ErrInvalidPayload
		}
		if id == 0x18538067 {
			if err := rejectChainedTrailer(s, next, []byte{0x18, 0x53, 0x80, 0x67}); err != nil {
				return 0, err
			}
			return next, nil
		}
		if open {
			return 0, ErrInvalidPayload
		}
		off = next
	}
	return 0, ErrInvalidPayload
}

func rejectChainedTrailer(s payloadSource, end int64, marker []byte) error {
	if s.size-end < int64(len(marker)) {
		return nil
	}
	var next [4]byte
	if err := s.read(end, next[:]); err != nil {
		return err
	}
	if bytes.Equal(next[:], marker) {
		return ErrUnsupportedPayload
	}
	return nil
}

func metadataMP4End(s payloadSource) (int64, error) {
	movie, media := false, false
	for off := int64(0); off < s.size; {
		kind, _, next, err := formatAtom(s, off, s.size)
		if err != nil {
			// Keep only bytes outside the complete top-level atom sequence opaque.
			// The existing validator still verifies all media references inside it.
			if movie && media && errors.Is(err, ErrInvalidPayload) {
				return off, nil
			}
			return 0, err
		}
		movie = movie || kind == "moov"
		media = media || kind == "mdat"
		off = next
	}
	return s.size, nil
}

// tailWorkingCopy hides a separated trailer from the tag writer and tracks the
// new logical size without requiring paths, Stat, or Seek on WorkingCopy.
type tailWorkingCopy struct {
	WorkingCopy
	size int64
}

func (f *tailWorkingCopy) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, ErrInvalidPayload
	}
	if len(p) == 0 {
		return 0, nil
	}
	if off >= f.size {
		return 0, io.EOF
	}
	n := min(int64(len(p)), f.size-off)
	read, err := f.WorkingCopy.ReadAt(p[:n], off)
	if err == nil && read < len(p) {
		err = io.EOF
	}
	return read, err
}

func (f *tailWorkingCopy) WriteAt(p []byte, off int64) (int, error) {
	n, err := f.WorkingCopy.WriteAt(p, off)
	f.size = max(f.size, off+int64(n))
	return n, err
}

func (f *tailWorkingCopy) Truncate(size int64) error {
	if err := f.WorkingCopy.Truncate(size); err != nil {
		return err
	}
	f.size = size
	return nil
}
