package rpm

import (
	"bytes"
	"encoding/binary"
)

// IndexEntry is an opaque, already-encoded value for a single RPM header or
// signature tag. Callers never inspect it; they construct one with an Entry*
// helper and hand it to PackageBuilder.AddCustomTag / AddCustomSig (or it is
// produced internally by the builder). The accessor methods are unexported so
// the type stays opaque while still satisfying the house rule that every public
// component is an interface rather than a struct.
type IndexEntry interface {
	// rpmType is the on-disk RPM type code (typeInt32, typeString, ...).
	rpmType() int
	// count is the number of logical elements (array length, or 1 for a scalar
	// string / I18N string). For BIN it is the byte length.
	count() int
	// data is the big-endian encoded payload, without any alignment padding.
	data() []byte
}

type indexEntry struct {
	rpmtype int
	cnt     int
	raw     []byte
}

func (e *indexEntry) rpmType() int { return e.rpmtype }
func (e *indexEntry) count() int   { return e.cnt }
func (e *indexEntry) data() []byte { return e.raw }

// rpmInt constrains the fixed-width integer element types RPM understands.
type rpmInt interface {
	~int8 | ~uint8 | ~int16 | ~uint16 | ~int32 | ~uint32 | ~int64 | ~uint64
}

func intEntry[T rpmInt](rpmType int, values []T) IndexEntry {
	buf := &bytes.Buffer{}
	// binary.Write on a bytes.Buffer only fails on OOM (which panics anyway), so
	// the error is impossible here for fixed-size slices.
	_ = binary.Write(buf, binary.BigEndian, values)
	return &indexEntry{rpmtype: rpmType, cnt: len(values), raw: buf.Bytes()}
}

// EntryInt8 encodes a CHAR/INT8 array. RPM uses INT8 for byte-sized integers.
func EntryInt8(v []int8) IndexEntry { return intEntry(typeInt8, v) }

// EntryUint8 encodes an INT8 array from unsigned bytes. Use EntryBytes for an
// opaque binary blob (BIN type).
func EntryUint8(v []uint8) IndexEntry { return intEntry(typeInt8, v) }

// EntryInt16 encodes an INT16 array.
func EntryInt16(v []int16) IndexEntry { return intEntry(typeInt16, v) }

// EntryUint16 encodes an INT16 array.
func EntryUint16(v []uint16) IndexEntry { return intEntry(typeInt16, v) }

// EntryInt32 encodes an INT32 array.
func EntryInt32(v []int32) IndexEntry { return intEntry(typeInt32, v) }

// EntryUint32 encodes an INT32 array.
func EntryUint32(v []uint32) IndexEntry { return intEntry(typeInt32, v) }

// EntryInt64 encodes an INT64 array.
func EntryInt64(v []int64) IndexEntry { return intEntry(typeInt64, v) }

// EntryUint64 encodes an INT64 array.
func EntryUint64(v []uint64) IndexEntry { return intEntry(typeInt64, v) }

// EntryString encodes a single NUL-terminated STRING (count 1).
func EntryString(v string) IndexEntry {
	return &indexEntry{rpmtype: typeString, cnt: 1, raw: append([]byte(v), 0)}
}

// EntryI18NString encodes a single NUL-terminated I18NSTRING (count 1). The
// header must carry a HEADERI18NTABLE listing the locales.
func EntryI18NString(v string) IndexEntry {
	return &indexEntry{rpmtype: typeI18NString, cnt: 1, raw: append([]byte(v), 0)}
}

// EntryBytes encodes an opaque BIN blob. count is the byte length.
func EntryBytes(v []byte) IndexEntry {
	return &indexEntry{rpmtype: typeBin, cnt: len(v), raw: v}
}

// EntryStringSlice encodes a STRING_ARRAY: each element is NUL-terminated and the
// count is the number of elements.
func EntryStringSlice(v []string) IndexEntry {
	buf := &bytes.Buffer{}
	for _, s := range v {
		buf.WriteString(s)
		buf.WriteByte(0)
	}
	return &indexEntry{rpmtype: typeStringArray, cnt: len(v), raw: buf.Bytes()}
}
