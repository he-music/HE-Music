package rpm

import (
	"bytes"
	"encoding/binary"
	"sort"
)

// index.go implements the RPM header/signature index encoder. Both the signature
// section and the main header use the identical on-disk structure:
//
//	8 bytes   magic 8e ad e8 01 + 4 reserved zero
//	4 bytes   number of index entries (INCLUDING the region trailer)
//	4 bytes   size of the data store in bytes
//	16*N      index entries (tag, type, offset, count), big-endian int32s,
//	          sorted ascending by tag, with the region trailer entry FIRST
//	size      the data store (entry payloads, integer-aligned)
//
// The first index entry is a "region" / immutable trailer: its index entry points
// (with a positive offset) at a 16-byte blob appended at the very END of the data
// store, and that blob points back (with a NEGATIVE offset) at the start of the
// index-entry array. This is rpm's tamper-evident region mechanism; getting the
// negative offset and the +1 count right is essential or rpm rejects the package.

// typeAlign maps integer entry types to their required data-store alignment. Only
// integer types are aligned: some rpm versions reject misaligned integers, and
// others reject aligned non-integers.
var typeAlign = map[int]int{
	typeInt16: 2,
	typeInt32: 4,
	typeInt64: 8,
}

type index struct {
	entries map[int]IndexEntry
	region  int
}

func newIndex(region int) *index {
	return &index{entries: make(map[int]IndexEntry), region: region}
}

// add stores (or replaces) an entry. A nil entry is ignored, which lets callers
// conditionally build entries without guarding every call site.
func (i *index) add(tag int, e IndexEntry) {
	if e == nil {
		return
	}
	i.entries[tag] = e
}

// addEntries merges a map of custom tags, allowing them to overwrite generated
// values (this matches rpmpack: custom tags are applied last).
func (i *index) addEntries(m map[int]IndexEntry) {
	for t, e := range m {
		i.add(t, e)
	}
}

func (i *index) sortedTags() []int {
	tags := make([]int, 0, len(i.entries))
	for t := range i.entries {
		tags = append(tags, t)
	}
	sort.Ints(tags)
	return tags
}

// pad aligns the data store for an integer entry of the given type.
func pad(buf *bytes.Buffer, rpmType int) {
	if b, ok := typeAlign[rpmType]; ok {
		if r := buf.Len() % b; r != 0 {
			buf.Write(make([]byte, b-r))
		}
	}
}

func writeIndexHeader(buf *bytes.Buffer, tag, rpmType, offset, count int) {
	var b [16]byte
	binary.BigEndian.PutUint32(b[0:], uint32(tag))
	binary.BigEndian.PutUint32(b[4:], uint32(rpmType))
	binary.BigEndian.PutUint32(b[8:], uint32(int32(offset)))
	binary.BigEndian.PutUint32(b[12:], uint32(count))
	buf.Write(b[:])
}

// regionTrailer builds the 16-byte data blob for the region entry: it points back
// at the index-entry array with a negative offset of -(16 * (numEntries+1)),
// where the +1 accounts for the region entry itself.
func regionTrailer(region, numEntries int) []byte {
	var b [16]byte
	binary.BigEndian.PutUint32(b[0:], uint32(region))
	binary.BigEndian.PutUint32(b[4:], uint32(typeBin))
	binary.BigEndian.PutUint32(b[8:], uint32(int32(-(16 * (numEntries + 1)))))
	binary.BigEndian.PutUint32(b[12:], 16)
	return b[:]
}

// bytes serializes the index to its on-disk representation.
func (i *index) bytes() []byte {
	tags := i.sortedTags()

	data := &bytes.Buffer{}
	offsets := make([]int, len(tags))
	for idx, tag := range tags {
		e := i.entries[tag]
		pad(data, e.rpmType())
		offsets[idx] = data.Len()
		data.Write(e.data())
	}
	// The region trailer's data is appended last; its index entry sorts first.
	regionOffset := data.Len()
	data.Write(regionTrailer(i.region, len(tags)))

	out := &bytes.Buffer{}
	out.Write(headerMagic)
	var cs [8]byte
	binary.BigEndian.PutUint32(cs[0:], uint32(len(tags)+1)) // +1 for the trailer
	binary.BigEndian.PutUint32(cs[4:], uint32(data.Len()))
	out.Write(cs[:])

	// Region entry first, then the real entries in tag order.
	writeIndexHeader(out, i.region, typeBin, regionOffset, 16)
	for idx, tag := range tags {
		e := i.entries[tag]
		writeIndexHeader(out, tag, e.rpmType(), offsets[idx], e.count())
	}
	out.Write(data.Bytes())
	return out.Bytes()
}
