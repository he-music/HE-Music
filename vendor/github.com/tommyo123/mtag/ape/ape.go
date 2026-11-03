// Package ape reads and writes APEv1 / APEv2 tags.
//
// APE is a key/value tag format originating with Monkey's Audio. It
// is most commonly found at the end of a file, optionally preceded
// by a copy of its 32-byte footer (an "APE header" — same struct
// with a different flag bit). Many MP3 collections combine an APE
// tag with an ID3v1 footer; in that case APE sits immediately
// before the ID3v1.
//
// The structure (all multi-byte values little-endian) is:
//
//	[optional 32-byte header]
//	   "APETAGEX" (8) | version (4) | size (4) | n_fields (4) |
//	   flags (4) | reserved (8)
//	field*N
//	   value_size (4) | flags (4) | name (ASCII, NUL-term) | value
//	[mandatory 32-byte footer, identical layout to header but
//	 without the "is header" flag]
//
// "size" in the footer is the byte length of the fields *plus* the
// footer itself, but excludes the optional header.
package ape

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// FooterSize is the fixed length of the APE header / footer.
const FooterSize = 32

// CurrentVersion is the version number written for new APEv2 tags.
const CurrentVersion = 2000

// MaxTagRegionSize caps how many bytes of trailing APE metadata mtag
// will materialise from a single file.
const MaxTagRegionSize = 64 << 20

// Magic is the eight-byte signature shared by header and footer.
var Magic = [8]byte{'A', 'P', 'E', 'T', 'A', 'G', 'E', 'X'}

// Tag-level flag bits (footer / header `flags` field).
const (
	flagContainsHeader uint32 = 1 << 31
	flagContainsFooter uint32 = 1 << 30
	flagIsHeader       uint32 = 1 << 29
)

// Field-level flag bits.
const (
	FieldReadOnly uint32 = 1 << 0

	fieldDataMask uint32 = 0x06
	fieldDataUTF8 uint32 = 0 << 1
	fieldDataBin  uint32 = 1 << 1
	fieldDataExt  uint32 = 2 << 1
)

// FieldType classifies an APE field's payload.
type FieldType uint8

const (
	FieldText     FieldType = iota // UTF-8 string (the common case)
	FieldBinary                    // arbitrary binary blob (e.g. cover art)
	FieldExternal                  // URL / path to data outside the file
	FieldReserved
)

// Standard APE field names. APE field lookup is case-insensitive
// per spec; on disk the case from the writer is preserved.
const (
	FieldTitle         = "Title"
	FieldArtist        = "Artist"
	FieldAlbum         = "Album"
	FieldAlbumArtist   = "Album Artist"
	FieldComposer      = "Composer"
	FieldYear          = "Year"
	FieldTrack         = "Track"
	FieldDisc          = "Disc"
	FieldGenre         = "Genre"
	FieldComment       = "Comment"
	FieldLyrics        = "Lyrics"
	FieldCoverArtFront = "Cover Art (Front)"
	FieldCoverArtBack  = "Cover Art (Back)"
)

// ErrNotPresent is returned when the trailing 32 bytes do not look
// like an APE footer.
var ErrNotPresent = errors.New("ape: tag not present")

// ErrTagTooLarge is returned when the declared trailing tag region
// exceeds [MaxTagRegionSize].
var ErrTagTooLarge = errors.New("ape: tag exceeds size cap")

// Field is one APE key/value entry. Value is the raw bytes for
// binary fields and the UTF-8 payload for text fields.
type Field struct {
	Name  string
	Value []byte
	flags uint32
}

// Type returns whether the field carries text, binary or external
// data.
func (f *Field) Type() FieldType {
	switch f.flags & fieldDataMask {
	case fieldDataBin:
		return FieldBinary
	case fieldDataExt:
		return FieldExternal
	case fieldDataUTF8:
		return FieldText
	}
	return FieldReserved
}

// IsText reports whether the field's payload should be interpreted
// as a UTF-8 string. Multi-value text fields use NUL as separator.
func (f *Field) IsText() bool { return f.Type() == FieldText }

// IsBinary reports whether the field's payload is opaque bytes.
// APE binary fields conventionally start with a NUL-terminated
// "extension" hint (e.g. "jpeg\0...") followed by the data; mtag
// preserves the prefix verbatim.
func (f *Field) IsBinary() bool { return f.Type() == FieldBinary }

// ReadOnly reports whether the read-only flag is set.
func (f *Field) ReadOnly() bool { return f.flags&FieldReadOnly != 0 }

// Text returns the field value as a UTF-8 string. For multi-value
// text fields use TextValues.
func (f *Field) Text() string { return string(f.Value) }

// TextValues splits a multi-value text field at NUL boundaries.
// Empty result for non-text fields.
func (f *Field) TextValues() []string {
	if !f.IsText() {
		return nil
	}
	parts := bytes.Split(f.Value, []byte{0})
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = string(p)
	}
	return out
}

// Tag is an in-memory APE tag.
type Tag struct {
	Version   int
	HasHeader bool // true when the original on-disk tag included a 32-byte header
	Fields    []Field
}

// New returns an empty APEv2 tag suitable for fresh writes.
func New() *Tag {
	return &Tag{Version: CurrentVersion, HasHeader: true}
}

// Find returns the first field whose name matches (case-insensitively).
func (t *Tag) Find(name string) *Field {
	for i := range t.Fields {
		if equalFold(t.Fields[i].Name, name) {
			return &t.Fields[i]
		}
	}
	return nil
}

// Get returns the text value of name, or "".
func (t *Tag) Get(name string) string {
	if f := t.Find(name); f != nil && f.IsText() {
		return f.Text()
	}
	return ""
}

// Set writes a UTF-8 text field, replacing any existing entry with
// the same (case-insensitive) name. An empty value deletes the
// field.
func (t *Tag) Set(name, value string) {
	t.Remove(name)
	if value == "" {
		return
	}
	t.Fields = append(t.Fields, Field{
		Name:  name,
		Value: []byte(value),
		flags: fieldDataUTF8,
	})
}

// SetBinary writes a binary field, replacing any existing entry.
func (t *Tag) SetBinary(name string, data []byte) {
	t.Remove(name)
	if data == nil {
		return
	}
	t.Fields = append(t.Fields, Field{
		Name:  name,
		Value: append([]byte(nil), data...),
		flags: fieldDataBin,
	})
}

// Remove deletes every field whose name matches (case-insensitive).
// Returns the number of removed entries.
func (t *Tag) Remove(name string) int {
	kept := t.Fields[:0]
	n := 0
	for _, f := range t.Fields {
		if equalFold(f.Name, name) {
			n++
			continue
		}
		kept = append(kept, f)
	}
	t.Fields = kept
	return n
}

// Region locates the APE tag inside a file already known to end at
// a footer. It returns the absolute byte offset of the tag's first
// byte (header or fields, depending on HasHeader) and its total
// byte length, or (0, 0, ErrNotPresent) when no footer is found at
// the requested end offset.
//
// The end argument lets callers skip an ID3v1 footer they have
// already detected — pass `fileSize - 128` in that case.
func Region(r io.ReaderAt, end int64) (offset, length int64, err error) {
	if end < FooterSize {
		return 0, 0, ErrNotPresent
	}
	var foot [FooterSize]byte
	if _, err := r.ReadAt(foot[:], end-FooterSize); err != nil {
		return 0, 0, err
	}
	if [8]byte(foot[:8]) != Magic {
		return 0, 0, ErrNotPresent
	}
	flags := binary.LittleEndian.Uint32(foot[20:24])
	size := int64(binary.LittleEndian.Uint32(foot[12:16]))
	total := size
	if flags&flagContainsHeader != 0 {
		total += FooterSize
	}
	if total < FooterSize || total > end {
		return 0, 0, fmt.Errorf("ape: implausible tag size %d", total)
	}
	if total > MaxTagRegionSize {
		return 0, 0, ErrTagTooLarge
	}
	return end - total, total, nil
}

// Read parses the APE tag whose footer terminates at end. It is
// the caller's responsibility to subtract any ID3v1 footer length
// before invoking Read.
func Read(r io.ReaderAt, end int64) (*Tag, int64, error) {
	offset, length, err := Region(r, end)
	if err != nil {
		return nil, 0, err
	}
	body := make([]byte, length)
	if _, err := r.ReadAt(body, offset); err != nil {
		return nil, 0, err
	}
	t, err := Decode(body)
	if err != nil {
		return nil, 0, err
	}
	return t, offset, nil
}

// Decode parses a complete APE region (header — when present —
// plus fields plus footer).
func Decode(b []byte) (*Tag, error) {
	if len(b) < FooterSize {
		return nil, fmt.Errorf("ape: tag region too short")
	}
	footStart := len(b) - FooterSize
	footer := b[footStart:]
	if [8]byte(footer[:8]) != Magic {
		return nil, ErrNotPresent
	}
	version := int(binary.LittleEndian.Uint32(footer[8:12]))
	size := int(binary.LittleEndian.Uint32(footer[12:16]))
	nFields := int(binary.LittleEndian.Uint32(footer[16:20]))
	flags := binary.LittleEndian.Uint32(footer[20:24])

	hasHeader := flags&flagContainsHeader != 0
	fieldsStart := 0
	if hasHeader {
		if len(b) < 2*FooterSize {
			return nil, fmt.Errorf("ape: header flag set but tag too short")
		}
		fieldsStart = FooterSize
	}
	fieldsEnd := fieldsStart + (size - FooterSize)
	if fieldsEnd > footStart || fieldsEnd < fieldsStart {
		return nil, fmt.Errorf("ape: footer size %d does not match region", size)
	}
	fields, err := decodeFields(b[fieldsStart:fieldsEnd], nFields)
	if err != nil {
		return nil, err
	}
	return &Tag{
		Version:   version,
		HasHeader: hasHeader,
		Fields:    fields,
	}, nil
}

func decodeFields(b []byte, expected int) ([]Field, error) {
	// A field record is at least 9 bytes (8-byte header + NUL name
	// terminator), so cap the preallocation hint accordingly.
	hint := expected
	if hint < 0 || hint > len(b)/9 {
		hint = len(b) / 9
	}
	out := make([]Field, 0, hint)
	cur := 0
	for cur < len(b) {
		if cur+8 > len(b) {
			return nil, fmt.Errorf("ape: truncated field header at %d", cur)
		}
		valueLen := int(binary.LittleEndian.Uint32(b[cur:]))
		flags := binary.LittleEndian.Uint32(b[cur+4:])
		cur += 8
		nameEnd := bytes.IndexByte(b[cur:], 0)
		if nameEnd < 0 {
			return nil, fmt.Errorf("ape: field name not NUL-terminated")
		}
		name := string(b[cur : cur+nameEnd])
		cur += nameEnd + 1
		if cur+valueLen > len(b) {
			return nil, fmt.Errorf("ape: field %q value overruns region", name)
		}
		value := append([]byte(nil), b[cur:cur+valueLen]...)
		cur += valueLen
		out = append(out, Field{Name: name, Value: value, flags: flags})
	}
	return out, nil
}

// Encode serialises the tag into a byte slice ready to be written
// as the trailing region of a file. The result always includes the
// 32-byte footer; a 32-byte header is also written when the tag
// has HasHeader set (or has been freshly created via [New]).
func (t *Tag) Encode() ([]byte, error) {
	var fieldsBuf bytes.Buffer
	for _, f := range t.Fields {
		var hdr [8]byte
		binary.LittleEndian.PutUint32(hdr[0:4], uint32(len(f.Value)))
		binary.LittleEndian.PutUint32(hdr[4:8], f.flags)
		fieldsBuf.Write(hdr[:])
		fieldsBuf.WriteString(f.Name)
		fieldsBuf.WriteByte(0)
		fieldsBuf.Write(f.Value)
	}
	fieldBytes := fieldsBuf.Bytes()
	tagSize := uint32(len(fieldBytes) + FooterSize)
	flagsFooter := flagContainsFooter
	if t.HasHeader {
		flagsFooter |= flagContainsHeader
	}

	var out bytes.Buffer
	if t.HasHeader {
		out.Write(makeFooter(uint32(t.Version), tagSize, uint32(len(t.Fields)),
			flagsFooter|flagIsHeader))
	}
	out.Write(fieldBytes)
	out.Write(makeFooter(uint32(t.Version), tagSize, uint32(len(t.Fields)),
		flagsFooter))
	return out.Bytes(), nil
}

func makeFooter(version, size, nFields, flags uint32) []byte {
	var out [FooterSize]byte
	copy(out[0:8], Magic[:])
	binary.LittleEndian.PutUint32(out[8:12], version)
	binary.LittleEndian.PutUint32(out[12:16], size)
	binary.LittleEndian.PutUint32(out[16:20], nFields)
	binary.LittleEndian.PutUint32(out[20:24], flags)
	// reserved: bytes 24–31 stay zero
	return out[:]
}

// equalFold compares two ASCII strings case-insensitively.
func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
