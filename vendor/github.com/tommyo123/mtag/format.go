package mtag

import "strings"

// Format is a bit-mask identifying one or more tag formats present in
// (or requested for) a file. Multiple formats can be combined with
// bitwise OR.
type Format uint16

const (
	// FormatID3v1 covers ID3v1 and ID3v1.1 (they share the same
	// 128-byte footer; v1.1 is detected by the zero byte at offset
	// 125 and a non-zero track at offset 126).
	FormatID3v1 Format = 1 << iota
	// FormatID3v22 is ID3v2.2.0 (three-character frame IDs).
	FormatID3v22
	// FormatID3v23 is ID3v2.3.0.
	FormatID3v23
	// FormatID3v24 is ID3v2.4.0.
	FormatID3v24
)

// FormatID3v2Any matches any ID3v2 major version.
const FormatID3v2Any = FormatID3v22 | FormatID3v23 | FormatID3v24

// Has reports whether every bit in other is also set in f.
func (f Format) Has(other Format) bool { return f&other == other }

// HasAny reports whether any bit in other is set in f.
func (f Format) HasAny(other Format) bool { return f&other != 0 }

// String renders the format set as "v1+v2.3" and similar.
func (f Format) String() string {
	if f == 0 {
		return "none"
	}
	var parts []string
	if f.Has(FormatID3v1) {
		parts = append(parts, "v1")
	}
	if f.Has(FormatID3v22) {
		parts = append(parts, "v2.2")
	}
	if f.Has(FormatID3v23) {
		parts = append(parts, "v2.3")
	}
	if f.Has(FormatID3v24) {
		parts = append(parts, "v2.4")
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(parts, "+")
}
