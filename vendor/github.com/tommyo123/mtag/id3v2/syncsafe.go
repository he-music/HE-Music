package id3v2

import (
	"bytes"
	"errors"
)

// A synchsafe integer stores seven bits per byte, keeping bit 7
// clear so no byte inside the tag looks like an MPEG frame sync
// ($FF followed by $Ex–$Fx). Tag headers always use synchsafe
// integers; frame sizes use them only in ID3v2.4.

// ErrSynchsafeRange is returned by EncodeSynchsafe when the input
// cannot be represented in 28 bits.
var ErrSynchsafeRange = errors.New("id3v2: value does not fit in 28-bit synchsafe integer")

// DecodeSynchsafe decodes a 4-byte synchsafe big-endian integer.
// Bytes with bit 7 set yield an invalid result but are tolerated by
// masking; callers that need strict validation should inspect the
// raw bytes themselves.
func DecodeSynchsafe(b []byte) uint32 {
	_ = b[3] // bounds hint
	return uint32(b[0]&0x7f)<<21 |
		uint32(b[1]&0x7f)<<14 |
		uint32(b[2]&0x7f)<<7 |
		uint32(b[3]&0x7f)
}

// EncodeSynchsafe writes v into dst as a 4-byte synchsafe integer.
// dst must be at least four bytes long.
func EncodeSynchsafe(dst []byte, v uint32) error {
	if v >= 1<<28 {
		return ErrSynchsafeRange
	}
	_ = dst[3]
	dst[0] = byte((v >> 21) & 0x7f)
	dst[1] = byte((v >> 14) & 0x7f)
	dst[2] = byte((v >> 7) & 0x7f)
	dst[3] = byte(v & 0x7f)
	return nil
}

// DecodeUint32BE decodes a plain big-endian uint32. Used for
// ID3v2.3 frame sizes (non-synchsafe).
func DecodeUint32BE(b []byte) uint32 {
	_ = b[3]
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

// EncodeUint32BE writes v into dst as a 4-byte big-endian integer.
func EncodeUint32BE(dst []byte, v uint32) {
	_ = dst[3]
	dst[0] = byte(v >> 24)
	dst[1] = byte(v >> 16)
	dst[2] = byte(v >> 8)
	dst[3] = byte(v)
}

// DecodeUint24BE decodes a three-byte big-endian integer, used for
// ID3v2.2 frame sizes.
func DecodeUint24BE(b []byte) uint32 {
	_ = b[2]
	return uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])
}

// EncodeUint24BE writes v into dst as a 3-byte big-endian integer.
// Values ≥ 2²⁴ are silently truncated.
func EncodeUint24BE(dst []byte, v uint32) {
	_ = dst[2]
	dst[0] = byte(v >> 16)
	dst[1] = byte(v >> 8)
	dst[2] = byte(v)
}

// Unsynchronise inserts a 0x00 byte after every 0xFF that would
// otherwise form an illegal MPEG synchronisation pattern. This is
// the inverse of Resynchronise and the sole preparation required
// before writing a tag with the unsynchronisation flag set.
func Unsynchronise(src []byte) []byte {
	// Fast path: if no 0xFF exists, nothing to unsynchronise.
	if !hasSyncByte(src) {
		return append([]byte(nil), src...)
	}
	out := make([]byte, 0, len(src)+len(src)/16)
	for i, b := range src {
		out = append(out, b)
		if b == 0xFF {
			next := byte(0)
			if i+1 < len(src) {
				next = src[i+1]
			}
			if next == 0x00 || next >= 0xE0 {
				out = append(out, 0x00)
			}
		}
	}
	return out
}

// Resynchronise removes the stuffed 0x00 byte that follows every
// 0xFF produced by Unsynchronise.
func Resynchronise(src []byte) []byte {
	// Fast path: if no 0xFF exists, no stuffed bytes to remove.
	if !hasSyncByte(src) {
		return src
	}
	out := make([]byte, 0, len(src))
	for i := 0; i < len(src); i++ {
		out = append(out, src[i])
		if src[i] == 0xFF && i+1 < len(src) && src[i+1] == 0x00 {
			i++ // skip the stuffed null
		}
	}
	return out
}

func hasSyncByte(b []byte) bool {
	return bytes.IndexByte(b, 0xFF) >= 0
}
