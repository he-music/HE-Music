// Package id3v1 reads and writes the 128-byte ID3v1/ID3v1.1 footer
// found at the end of many MP3 files.
//
// The format is rigidly fixed: three magic bytes "TAG", followed by
// four 30-byte text fields, a 4-byte year, a 30-byte comment, and a
// single genre byte. ID3v1.1 repurposes the last two bytes of the
// comment field as a zero separator and a track number.
//
// All text fields are ISO-8859-1 encoded, null- or space-padded to
// their fixed length. This package decodes them into Go strings (UTF-8)
// on read and re-encodes on write, replacing characters that fall
// outside ISO-8859-1 with '?'.
package id3v1

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Size is the constant byte size of an ID3v1 footer.
const Size = 128

// Magic is the three-byte signature at the start of an ID3v1 footer.
var Magic = [3]byte{'T', 'A', 'G'}

// ErrNotPresent is returned by Read when the last 128 bytes of the
// file do not begin with the "TAG" signature.
var ErrNotPresent = errors.New("id3v1: tag not present")

// Tag is a decoded ID3v1 / ID3v1.1 footer.
type Tag struct {
	Title   string
	Artist  string
	Album   string
	Year    string // kept as string because the spec is 4 ASCII bytes
	Comment string
	Track   byte // 0 means "no track" (equivalent to ID3v1.0)
	Genre   byte // 255 means "no genre"
}

// HasTrack reports whether the tag carries an ID3v1.1 track number.
func (t *Tag) HasTrack() bool { return t.Track != 0 }

// GenreName returns the human-readable genre for t.Genre.
func (t *Tag) GenreName() string { return GenreName(t.Genre) }

// SetGenreName sets t.Genre by looking up name in the canonical table.
// Unknown names set the genre to 255 ("no genre").
func (t *Tag) SetGenreName(name string) { t.Genre = GenreID(name) }

// YearInt returns the year as an integer, or 0 if the field is not a
// valid number.
func (t *Tag) YearInt() int {
	n, _ := strconv.Atoi(strings.TrimSpace(t.Year))
	return n
}

// Read parses the 128-byte footer at the end of r. r must implement
// io.ReaderAt and have a known length; typical callers pass *os.File.
func Read(r io.ReaderAt, size int64) (*Tag, error) {
	if size < Size {
		return nil, ErrNotPresent
	}
	var buf [Size]byte
	if _, err := r.ReadAt(buf[:], size-Size); err != nil {
		return nil, fmt.Errorf("id3v1: read footer: %w", err)
	}
	return Decode(buf[:])
}

// ReadFile is a convenience wrapper around Read for os.File-style
// inputs.
func ReadFile(f *os.File) (*Tag, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return Read(f, info.Size())
}

// Decode parses a 128-byte ID3v1 footer. The buffer must start with
// "TAG".
func Decode(buf []byte) (*Tag, error) {
	if len(buf) != Size {
		return nil, fmt.Errorf("id3v1: expected %d bytes, got %d", Size, len(buf))
	}
	if !bytes.Equal(buf[:3], Magic[:]) {
		return nil, ErrNotPresent
	}
	t := &Tag{
		Title:  decodeField(buf[3:33]),
		Artist: decodeField(buf[33:63]),
		Album:  buf63to92(buf),
		Year:   decodeField(buf[93:97]),
		Genre:  buf[127],
	}
	// Detect v1.1 (zero at 125, non-zero track at 126).
	if buf[125] == 0 && buf[126] != 0 {
		t.Comment = decodeField(buf[97:125])
		t.Track = buf[126]
	} else {
		t.Comment = decodeField(buf[97:127])
	}
	return t, nil
}

func buf63to92(b []byte) string { return decodeField(b[63:93]) }

// Encode serialises t into a 128-byte buffer ready to be written to
// the last 128 bytes of a file.
func (t *Tag) Encode() [Size]byte {
	var out [Size]byte
	copy(out[0:3], Magic[:])
	encodeField(out[3:33], t.Title)
	encodeField(out[33:63], t.Artist)
	encodeField(out[63:93], t.Album)
	encodeField(out[93:97], t.Year)
	if t.Track != 0 {
		encodeField(out[97:125], t.Comment)
		out[125] = 0
		out[126] = t.Track
	} else {
		encodeField(out[97:127], t.Comment)
	}
	out[127] = t.Genre
	return out
}

// WriteAt patches the ID3v1 footer into the end of w. If size already
// ends with an ID3v1 footer the existing 128 bytes are overwritten in
// place; otherwise the footer is appended and the new file size is
// returned.
func (t *Tag) WriteAt(w io.WriterAt, size int64) (int64, error) {
	enc := t.Encode()
	// Detect an existing footer so we overwrite instead of append.
	if ra, ok := w.(io.ReaderAt); ok && size >= Size {
		var head [3]byte
		if _, err := ra.ReadAt(head[:], size-Size); err == nil && head == Magic {
			_, err := w.WriteAt(enc[:], size-Size)
			return size, err
		}
	}
	if _, err := w.WriteAt(enc[:], size); err != nil {
		return size, err
	}
	return size + Size, nil
}

// decodeField turns a fixed-width ISO-8859-1 field into a Go string,
// trimming trailing NULs and whitespace.
func decodeField(b []byte) string {
	// Cut at first NUL.
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	// ISO-8859-1 → UTF-8.
	var sb strings.Builder
	sb.Grow(len(b))
	for _, c := range b {
		sb.WriteRune(rune(c))
	}
	return strings.TrimRight(sb.String(), " \t")
}

// encodeField writes s into the fixed-width, NUL-padded field dst.
// Characters outside ISO-8859-1 are replaced with '?'.
func encodeField(dst []byte, s string) {
	for i := range dst {
		dst[i] = 0
	}
	i := 0
	for _, r := range s {
		if i >= len(dst) {
			return
		}
		if r > 0xFF {
			dst[i] = '?'
		} else {
			dst[i] = byte(r)
		}
		i++
	}
}
