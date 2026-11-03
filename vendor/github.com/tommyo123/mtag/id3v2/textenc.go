package id3v2

import (
	"bytes"
	"errors"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Encoding is the byte prefix that identifies a text encoding inside
// ID3v2 frames. The values match the on-wire representation.
type Encoding byte

const (
	EncISO8859 Encoding = 0x00 // ISO-8859-1, NUL-terminated
	EncUTF16   Encoding = 0x01 // UTF-16 with BOM, double-NUL-terminated
	EncUTF16BE Encoding = 0x02 // UTF-16BE without BOM, double-NUL-terminated (v2.4+)
	EncUTF8    Encoding = 0x03 // UTF-8, NUL-terminated (v2.4+)
)

// Valid reports whether e is a recognised encoding byte.
func (e Encoding) Valid() bool { return e <= EncUTF8 }

// ErrInvalidEncoding is returned when a frame begins with an
// unrecognised encoding byte.
var ErrInvalidEncoding = errors.New("id3v2: invalid text encoding")

// DecodeString interprets data as a single string in the given
// encoding, stripping at most one trailing terminator. Any embedded
// NULs are preserved so that callers that receive multi-string
// frames can split them themselves (see SplitStrings).
func DecodeString(enc Encoding, data []byte) (string, error) {
	switch enc {
	case EncISO8859:
		return decodeLatin1(trimOneTerminator(data, 1)), nil
	case EncUTF8:
		return string(trimOneTerminator(data, 1)), nil
	case EncUTF16:
		return decodeUTF16(trimOneTerminator(data, 2), true)
	case EncUTF16BE:
		return decodeUTF16(trimOneTerminator(data, 2), false)
	default:
		return "", ErrInvalidEncoding
	}
}

// SplitTerminated extracts the first terminated string from data and
// returns the decoded value plus the byte offset immediately after
// the terminator. Used to parse the description fields of COMM,
// APIC, TXXX etc.
func SplitTerminated(enc Encoding, data []byte) (string, int, error) {
	switch enc {
	case EncISO8859, EncUTF8:
		i := bytes.IndexByte(data, 0)
		if i < 0 {
			s, err := DecodeString(enc, data)
			return s, len(data), err
		}
		s, err := DecodeString(enc, data[:i])
		return s, i + 1, err
	case EncUTF16, EncUTF16BE:
		i := indexDoubleNUL(data)
		if i < 0 {
			s, err := DecodeString(enc, data)
			return s, len(data), err
		}
		s, err := DecodeString(enc, data[:i])
		return s, i + 2, err
	default:
		return "", 0, ErrInvalidEncoding
	}
}

// SplitStrings splits data into the list of NUL-separated strings
// allowed by ID3v2.4 for multi-valued text frames.
func SplitStrings(enc Encoding, data []byte) ([]string, error) {
	if len(data) == 0 {
		return nil, nil
	}
	parts := make([]string, 0, 4)
	cur := 0
	for cur < len(data) {
		s, n, err := SplitTerminated(enc, data[cur:])
		if err != nil {
			return nil, err
		}
		parts = append(parts, s)
		cur += n
		// If SplitTerminated consumed the remainder without a
		// terminator we must still stop.
		if n == 0 {
			break
		}
	}
	// Drop a trailing empty string caused by a terminator at the
	// very end of data — this is benign padding, not a real value.
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts, nil
}

// EncodeString encodes s using enc. terminator controls whether the
// canonical NUL terminator is appended.
func EncodeString(enc Encoding, s string, terminator bool) ([]byte, error) {
	switch enc {
	case EncISO8859:
		out := make([]byte, 0, len(s)+1)
		for _, r := range s {
			if r > 0xFF {
				out = append(out, '?')
			} else {
				out = append(out, byte(r))
			}
		}
		if terminator {
			out = append(out, 0)
		}
		return out, nil
	case EncUTF8:
		out := make([]byte, 0, len(s)+1)
		out = append(out, s...)
		if terminator {
			out = append(out, 0)
		}
		return out, nil
	case EncUTF16:
		u := utf16.Encode([]rune(s))
		out := make([]byte, 0, 2+len(u)*2+2)
		out = append(out, 0xFF, 0xFE) // little-endian BOM
		for _, r := range u {
			out = append(out, byte(r), byte(r>>8))
		}
		if terminator {
			out = append(out, 0, 0)
		}
		return out, nil
	case EncUTF16BE:
		u := utf16.Encode([]rune(s))
		out := make([]byte, 0, len(u)*2+2)
		for _, r := range u {
			out = append(out, byte(r>>8), byte(r))
		}
		if terminator {
			out = append(out, 0, 0)
		}
		return out, nil
	default:
		return nil, ErrInvalidEncoding
	}
}

// PickEncoding selects the most conservative encoding that can
// represent every string in values for the given tag major version.
// Plain ASCII → ISO-8859-1; any wider input picks UTF-8 for 2.4 and
// UTF-16 for 2.2/2.3.
func PickEncoding(version byte, values ...string) Encoding {
	allASCII := true
	allLatin1 := true
	for _, v := range values {
		for _, r := range v {
			if r > 0x7F {
				allASCII = false
			}
			if r > 0xFF {
				allLatin1 = false
				break
			}
		}
		if !allLatin1 {
			break
		}
	}
	if allASCII {
		return EncISO8859
	}
	if allLatin1 && version < 4 {
		// ISO-8859-1 covers it and every version supports it; use
		// UTF-16 for v2.2/2.3 only if we truly need it.
		return EncISO8859
	}
	if version >= 4 {
		return EncUTF8
	}
	return EncUTF16
}

// trimOneTerminator drops a single trailing terminator of width n.
func trimOneTerminator(data []byte, n int) []byte {
	if n == 1 && len(data) > 0 && data[len(data)-1] == 0 {
		return data[:len(data)-1]
	}
	if n == 2 && len(data) >= 2 && data[len(data)-2] == 0 && data[len(data)-1] == 0 {
		return data[:len(data)-2]
	}
	return data
}

// indexDoubleNUL returns the start index of the first aligned
// $00 $00 pair or −1 if none exists. Alignment matters because
// UTF-16 can contain a lone zero byte inside a wider code unit.
func indexDoubleNUL(data []byte) int {
	for i := 0; i+1 < len(data); i += 2 {
		if data[i] == 0 && data[i+1] == 0 {
			return i
		}
	}
	return -1
}

func decodeLatin1(b []byte) string {
	// Fast path: pure ASCII needs no conversion.
	ascii := true
	for _, c := range b {
		if c > 0x7F {
			ascii = false
			break
		}
	}
	if ascii {
		return string(b)
	}
	// Count non-ASCII bytes to size the buffer precisely.
	// Latin-1 0x80..0xFF expand to 2-byte UTF-8 sequences.
	extra := 0
	for _, c := range b {
		if c > 0x7F {
			extra++
		}
	}
	out := make([]byte, 0, len(b)+extra)
	var tmp [utf8.UTFMax]byte
	for _, c := range b {
		n := utf8.EncodeRune(tmp[:], rune(c))
		out = append(out, tmp[:n]...)
	}
	return string(out)
}

func decodeUTF16(b []byte, detectBOM bool) (string, error) {
	if len(b)%2 != 0 {
		// Tolerate an odd trailing byte by dropping it, which is
		// what most real-world decoders do.
		b = b[:len(b)-1]
	}
	littleEndian := false
	if detectBOM && len(b) >= 2 {
		switch {
		case b[0] == 0xFF && b[1] == 0xFE:
			littleEndian = true
			b = b[2:]
		case b[0] == 0xFE && b[1] == 0xFF:
			b = b[2:]
		}
	}
	var sb strings.Builder
	sb.Grow(len(b) / 2) // lower bound: one byte per code unit
	var surrogate uint16
	for i := 0; i+1 < len(b); i += 2 {
		var cu uint16
		if littleEndian {
			cu = uint16(b[i]) | uint16(b[i+1])<<8
		} else {
			cu = uint16(b[i])<<8 | uint16(b[i+1])
		}
		if surrogate != 0 {
			if cu >= 0xDC00 && cu <= 0xDFFF {
				r := 0x10000 + rune(surrogate-0xD800)<<10 + rune(cu-0xDC00)
				sb.WriteRune(r)
			} else {
				sb.WriteRune(utf8.RuneError)
				// Re-process current unit as non-surrogate.
				i -= 2
			}
			surrogate = 0
			continue
		}
		if cu >= 0xD800 && cu <= 0xDBFF {
			surrogate = cu
			continue
		}
		sb.WriteRune(rune(cu))
	}
	if surrogate != 0 {
		sb.WriteRune(utf8.RuneError)
	}
	return sb.String(), nil
}
