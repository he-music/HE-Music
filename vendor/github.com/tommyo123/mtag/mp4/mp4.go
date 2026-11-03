// Package mp4 reads iTunes-style metadata atoms from an MP4 / M4A
// stream.
//
// MP4 files are a tree of "atoms" (also called "boxes"). Each atom
// starts with a four-byte big-endian size, then a four-byte type
// FourCC, then size-8 bytes of payload. Most atoms are containers
// for nested atoms; leaf atoms hold raw data.
//
// iTunes-compatible metadata lives at moov → udta → meta → ilst.
// Each ilst child is named with a four-byte tag (e.g. "©nam" for
// title, "trkn" for track number, "covr" for cover art) and
// contains one or more "data" sub-atoms carrying the actual value
// plus a one-byte type indicator (UTF-8 string, big-endian
// integer, JPEG, PNG, …).
//
// This package focuses on extracting the ilst items. Walking the
// audio data, sample tables and so on is out of scope.
package mp4

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MagicOffset is the offset of the first atom's type field in a
// well-formed MP4 file (the four bytes preceding it are the size of
// the ftyp atom).
const MagicOffset = 4

// ErrNotMP4 is returned when no ftyp atom is found at the start of
// the file.
var ErrNotMP4 = errors.New("mp4: not an MP4 stream")

// DataType enumerates the iTunes well-known type indicators that
// appear inside an ilst "data" sub-atom.
type DataType uint32

const (
	DataBinary  DataType = 0
	DataUTF8    DataType = 1
	DataUTF16   DataType = 2
	DataJPEG    DataType = 13
	DataPNG     DataType = 14
	DataInteger DataType = 21
)

// Item is one decoded entry from the ilst atom: its four-byte name
// (e.g. "©nam", "trkn"), the iTunes type indicator, and the raw
// payload bytes (already stripped of the 8-byte data-atom header).
//
// Freeform atoms use the outer FourCC "----" plus a "mean" owner
// string and a "name" field string. For those entries Mean and
// FreeformName are populated and Key renders the stable
// "----:mean:name" identifier used by higher-level callers.
type Item struct {
	Name         [4]byte
	Type         DataType
	Data         []byte
	Mean         string
	FreeformName string
}

// MDTAItem is one metadata entry addressed through the `meta`/`keys`
// indirection used by the `mdta` handler.
type MDTAItem struct {
	Index int
	Key   string
	Type  DataType
	Data  []byte
}

// Key returns the stable identifier callers use to address the item.
// Normal ilst entries return their four-byte name; freeform atoms
// return "----:mean:name".
func (i Item) Key() string {
	if string(i.Name[:]) == "----" && (i.Mean != "" || i.FreeformName != "") {
		return "----:" + i.Mean + ":" + i.FreeformName
	}
	return string(i.Name[:])
}

// IsAudio inspects the leading bytes for an ftyp atom whose major
// brand is one of the well-known audio brands. It returns the
// brand string when matched and the empty string otherwise so
// callers can distinguish MP4 audio from MP4 video.
func IsAudio(r io.ReaderAt) (string, bool) {
	var head [16]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return "", false
	}
	if string(head[4:8]) != "ftyp" {
		return "", false
	}
	return string(head[8:12]), true
}

// ReadItems navigates moov / udta / meta / ilst and returns every
// metadata item it finds. Audio-bearing MP4 brands (M4A , M4B , M4P)
// always carry the metadata here; pure-video MP4s usually skip the
// udta sub-tree entirely, in which case ReadItems returns no items
// and no error.
func ReadItems(r io.ReaderAt, size int64) ([]Item, error) {
	items, _, err := ReadMetadata(r, size)
	return items, err
}

// ReadMetadata returns both classic ilst items and mdta/keys metadata items.
func ReadMetadata(r io.ReaderAt, size int64) ([]Item, []MDTAItem, error) {
	return readMetadata(r, size, false)
}

// ReadMetadataWithOptions is [ReadMetadata] with selective skipping
// for large metadata payloads the caller does not need.
func ReadMetadataWithOptions(r io.ReaderAt, size int64, skipPictures bool) ([]Item, []MDTAItem, error) {
	return readMetadata(r, size, skipPictures)
}

func readMetadata(r io.ReaderAt, size int64, skipPictures bool) ([]Item, []MDTAItem, error) {
	if size < 8 {
		return nil, nil, ErrNotMP4
	}
	var head [8]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, nil, err
	}
	if string(head[4:8]) != "ftyp" {
		return nil, nil, ErrNotMP4
	}

	moov, err := findChild(r, 0, size, "moov")
	if err != nil || moov.size == 0 {
		return nil, nil, err
	}
	udta, err := findChild(r, moov.dataAt, moov.dataAt+moov.dataSize, "udta")
	if err != nil || udta.size == 0 {
		return nil, nil, nil // metadata-less file
	}
	meta, err := findChild(r, udta.dataAt, udta.dataAt+udta.dataSize, "meta")
	if err != nil || meta.size == 0 {
		return nil, nil, nil
	}
	// "meta" is a full atom: skip the 4-byte version+flags prefix
	// before its sub-atoms.
	if meta.dataSize < 4 {
		return nil, nil, nil
	}
	metaFrom := meta.dataAt + 4
	metaTo := meta.dataAt + meta.dataSize
	var items []Item
	ilst, err := findChild(r, metaFrom, metaTo, "ilst")
	if err == nil && ilst.size != 0 {
		items, err = decodeILST(r, ilst.dataAt, ilst.dataAt+ilst.dataSize, skipPictures)
		if err != nil {
			return nil, nil, err
		}
	}
	var mdta []MDTAItem
	keys, _ := readMDTAKeys(r, metaFrom, metaTo)
	if len(keys) > 0 && ilst.size != 0 {
		mdta, _ = decodeMDTAILST(r, ilst.dataAt, ilst.dataAt+ilst.dataSize, keys)
	}
	return items, mdta, nil
}

// atomLoc records a single atom's position within the file.
type atomLoc struct {
	atomType [4]byte
	size     int64 // total atom length (header + data)
	dataAt   int64 // offset of the first body byte
	dataSize int64 // body length (= size - 8 for normal atoms)
}

// readAtomHeader reads one atom header at offset and returns its
// total size and where its body starts. Handles the 32-bit, 64-bit
// (size==1), and "extends to EOF" (size==0) encodings.
func readAtomHeader(r io.ReaderAt, offset, end int64) (atomLoc, error) {
	var hdr [16]byte
	if _, err := r.ReadAt(hdr[:8], offset); err != nil {
		return atomLoc{}, err
	}
	size := int64(binary.BigEndian.Uint32(hdr[:4]))
	loc := atomLoc{}
	copy(loc.atomType[:], hdr[4:8])
	switch {
	case size == 1:
		if _, err := r.ReadAt(hdr[8:16], offset+8); err != nil {
			return atomLoc{}, err
		}
		size = int64(binary.BigEndian.Uint64(hdr[8:16]))
		loc.size = size
		loc.dataAt = offset + 16
		loc.dataSize = size - 16
	case size == 0:
		loc.size = end - offset
		loc.dataAt = offset + 8
		loc.dataSize = loc.size - 8
	default:
		loc.size = size
		loc.dataAt = offset + 8
		loc.dataSize = size - 8
	}
	if loc.dataSize < 0 || offset+loc.size > end {
		return atomLoc{}, fmt.Errorf("mp4: atom %q at %d declares oversize length %d", loc.atomType, offset, loc.size)
	}
	return loc, nil
}

// likelyAtomType is a small heuristic used by the lenient scanner
// below. Real MP4 atom names are four printable bytes; the first
// byte is occasionally 0xA9 for iTunes-style "copyright" atoms.
func likelyAtomType(name []byte) bool {
	if len(name) != 4 {
		return false
	}
	for i, b := range name {
		if b == 0 {
			return false
		}
		if b == 0xA9 && i == 0 {
			continue
		}
		switch {
		case b >= 'A' && b <= 'Z':
		case b >= 'a' && b <= 'z':
		case b >= '0' && b <= '9':
		case b == ' ' || b == '-' || b == '_' || b == '.':
		default:
			return false
		}
	}
	return true
}

// scanForwardForAtom searches [from, to) for the next plausible atom
// header. When want is non-empty, only atoms with that exact type are
// considered. It is used to resync after a broken child atom.
func scanForwardForAtom(r io.ReaderAt, from, to int64, want string) (offset int64, loc atomLoc, ok bool) {
	const (
		window  = 64 << 10
		overlap = 15
	)
	if from < 0 {
		from = 0
	}
	buf := make([]byte, window+overlap)
	for base := from; base+8 <= to; {
		readLen := int(to - base)
		if readLen > len(buf) {
			readLen = len(buf)
		}
		n, err := r.ReadAt(buf[:readLen], base)
		if n < 8 {
			return 0, atomLoc{}, false
		}
		if err != nil && err != io.EOF {
			return 0, atomLoc{}, false
		}
		for i := 0; i+8 <= n; i++ {
			name := buf[i+4 : i+8]
			if want != "" {
				if string(name) != want {
					continue
				}
			} else if !likelyAtomType(name) {
				continue
			}
			pos := base + int64(i)
			loc, err := readAtomHeader(r, pos, to)
			if err == nil && (want == "" || string(loc.atomType[:]) == want) {
				return pos, loc, true
			}
		}
		if base+int64(n) >= to || n <= 8 {
			return 0, atomLoc{}, false
		}
		base += int64(n - 7)
	}
	return 0, atomLoc{}, false
}

// findChild locates the first direct child atom whose type matches
// name within [from, to). Returns a zero atomLoc when not found.
func findChild(r io.ReaderAt, from, to int64, name string) (atomLoc, error) {
	cursor := from
	for cursor+8 <= to {
		loc, err := readAtomHeader(r, cursor, to)
		if err != nil {
			if _, loc, ok := scanForwardForAtom(r, cursor+1, to, name); ok {
				return loc, nil
			}
			return atomLoc{}, nil
		}
		if string(loc.atomType[:]) == name {
			return loc, nil
		}
		cursor += loc.size
	}
	if _, loc, ok := scanForwardForAtom(r, from, to, name); ok {
		return loc, nil
	}
	return atomLoc{}, nil
}

// decodeILST walks every direct child of the ilst atom and decodes
// the embedded "data" sub-atom, returning one [Item] per ilst child.
// An ilst child can in principle hold multiple data sub-atoms; mtag
// returns each as its own Item so multi-value tags survive.
func decodeILST(r io.ReaderAt, from, to int64, skipPictures bool) ([]Item, error) {
	var items []Item
	cursor := from
	for cursor+8 <= to {
		entryAt := cursor
		entry, err := readAtomHeader(r, cursor, to)
		if err != nil {
			off, loc, ok := scanForwardForAtom(r, cursor+1, to, "")
			if !ok || off <= cursor {
				break
			}
			entryAt, entry = off, loc
		}
		if skipPictures && string(entry.atomType[:]) == "covr" {
			cursor = entryAt + entry.size
			continue
		}
		// Inside this ilst child, walk for one or more "data"
		// sub-atoms.
		sub := entry.dataAt
		subEnd := entry.dataAt + entry.dataSize
		var freeformMean, freeformName string
		for sub+16 <= subEnd {
			dataAt := sub
			data, err := readAtomHeader(r, sub, subEnd)
			if err != nil {
				off, loc, ok := scanForwardForAtom(r, sub+1, subEnd, "data")
				if !ok || off <= sub {
					break
				}
				dataAt, data = off, loc
			}
			switch string(data.atomType[:]) {
			case "mean", "name":
				if data.dataSize < 4 {
					sub = dataAt + data.size
					continue
				}
				body := make([]byte, data.dataSize-4)
				if len(body) > 0 {
					if _, err := r.ReadAt(body, data.dataAt+4); err != nil {
						sub = dataAt + data.size
						continue
					}
				}
				if string(data.atomType[:]) == "mean" {
					freeformMean = string(body)
				} else {
					freeformName = string(body)
				}
			case "data":
				if data.dataSize < 8 {
					sub = dataAt + data.size
					continue
				}
				var prefix [8]byte
				if _, err := r.ReadAt(prefix[:], data.dataAt); err != nil {
					sub = dataAt + data.size
					continue
				}
				typeIndicator := DataType(binary.BigEndian.Uint32(prefix[:4]) & 0x00FFFFFF)
				body := make([]byte, data.dataSize-8)
				if len(body) > 0 {
					if _, err := r.ReadAt(body, data.dataAt+8); err != nil {
						sub = dataAt + data.size
						continue
					}
				}
				items = append(items, Item{
					Name:         entry.atomType,
					Type:         typeIndicator,
					Data:         body,
					Mean:         freeformMean,
					FreeformName: freeformName,
				})
			}
			sub = dataAt + data.size
		}
		cursor = entryAt + entry.size
	}
	return items, nil
}

// ItemsByName returns every item whose Name matches the four-byte
// FourCC. The argument is taken as a string for ergonomics; callers
// pass `"©nam"`, `"trkn"`, etc.
func ItemsByName(items []Item, name string) []Item {
	var out []Item
	for _, it := range items {
		if it.Key() == name {
			out = append(out, it)
		}
	}
	return out
}

func readMDTAKeys(r io.ReaderAt, from, to int64) ([]string, error) {
	keysLoc, err := findChild(r, from, to, "keys")
	if err != nil || keysLoc.size == 0 {
		return nil, err
	}
	body, err := readAtomBody(r, keysLoc)
	if err != nil || len(body) < 8 {
		return nil, err
	}
	count := int(binary.BigEndian.Uint32(body[4:8]))
	keys := make([]string, count+1)
	cur := 8
	for i := 1; i <= count && cur+8 <= len(body); i++ {
		size := int(binary.BigEndian.Uint32(body[cur : cur+4]))
		if size < 8 || cur+size > len(body) {
			break
		}
		if string(body[cur+4:cur+8]) == "mdta" {
			keys[i] = string(body[cur+8 : cur+size])
		}
		cur += size
	}
	return keys, nil
}

func decodeMDTAILST(r io.ReaderAt, from, to int64, keys []string) ([]MDTAItem, error) {
	var out []MDTAItem
	cursor := from
	for cursor+8 <= to {
		entry, err := readAtomHeader(r, cursor, to)
		if err != nil || entry.size <= 0 {
			break
		}
		index := int(binary.BigEndian.Uint32(entry.atomType[:]))
		if index <= 0 || index >= len(keys) || keys[index] == "" {
			cursor += entry.size
			continue
		}
		sub := entry.dataAt
		for sub+8 <= entry.dataAt+entry.dataSize {
			data, err := readAtomHeader(r, sub, entry.dataAt+entry.dataSize)
			if err != nil || data.size <= 0 {
				break
			}
			if string(data.atomType[:]) == "data" && data.dataSize >= 8 {
				body := make([]byte, data.dataSize)
				if _, err := r.ReadAt(body, data.dataAt); err != nil {
					break
				}
				out = append(out, MDTAItem{
					Index: index,
					Key:   keys[index],
					Type:  DataType(binary.BigEndian.Uint32(body[0:4])),
					Data:  append([]byte(nil), body[8:]...),
				})
			}
			sub += data.size
		}
		cursor += entry.size
	}
	return out, nil
}

// ReadItemsAt is like [ReadItems] but also returns the absolute
// file offset of the ilst atom and its total size (including its
// 8-byte header). The caller uses these to rewrite the atom in
// place without touching the rest of the file.
func ReadItemsAt(r io.ReaderAt, size int64) (items []Item, ilstOffset, ilstSize int64, err error) {
	if size < 8 {
		return nil, 0, 0, ErrNotMP4
	}
	var head [8]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, 0, 0, err
	}
	if string(head[4:8]) != "ftyp" {
		return nil, 0, 0, ErrNotMP4
	}
	moov, err := findChild(r, 0, size, "moov")
	if err != nil || moov.size == 0 {
		return nil, 0, 0, err
	}
	udta, _ := findChild(r, moov.dataAt, moov.dataAt+moov.dataSize, "udta")
	if udta.size == 0 {
		return nil, 0, 0, nil
	}
	meta, _ := findChild(r, udta.dataAt, udta.dataAt+udta.dataSize, "meta")
	if meta.size == 0 {
		return nil, 0, 0, nil
	}
	if meta.dataSize < 4 {
		return nil, 0, 0, nil
	}
	ilst, _ := findChild(r, meta.dataAt+4, meta.dataAt+meta.dataSize, "ilst")
	if ilst.size == 0 {
		return nil, 0, 0, nil
	}
	items, err = decodeILST(r, ilst.dataAt, ilst.dataAt+ilst.dataSize, false)
	if err != nil {
		return nil, 0, 0, err
	}
	return items, ilst.dataAt - 8, ilst.size, nil
}

// EncodeItem serialises a single ilst item (outer atom + its data
// sub-atom) into the byte representation MP4 expects inside the
// ilst body. Freeform atoms add the mandatory "mean" and "name"
// children ahead of the data atom.
func EncodeItem(item Item) []byte {
	if string(item.Name[:]) == "----" {
		mean := encodeFreeformChunk("mean", item.Mean)
		name := encodeFreeformChunk("name", item.FreeformName)
		data := encodeDataChunk(item.Type, item.Data)
		total := 8 + len(mean) + len(name) + len(data)
		out := make([]byte, 0, total)
		out = append(out, encodeAtomHeader("----", total)...)
		out = append(out, mean...)
		out = append(out, name...)
		out = append(out, data...)
		return out
	}
	total := 24 + len(item.Data)
	out := make([]byte, total)
	binary.BigEndian.PutUint32(out[0:4], uint32(total))
	copy(out[4:8], item.Name[:])
	// data sub-atom: 8-byte header + 8-byte prefix + payload.
	binary.BigEndian.PutUint32(out[8:12], uint32(16+len(item.Data)))
	copy(out[12:16], []byte("data"))
	// First uint32 of the prefix: version (1 byte) + type (24 bits).
	binary.BigEndian.PutUint32(out[16:20], uint32(item.Type))
	// Locale (4 bytes): zeroes.
	copy(out[24:], item.Data)
	return out
}

// EncodeILSTBody builds the full byte body of an ilst atom from a
// slice of items. Callers wrap this in an outer ilst atom header
// when rewriting a file.
func EncodeILSTBody(items []Item) []byte {
	var total int
	for _, it := range items {
		total += len(EncodeItem(it))
	}
	out := make([]byte, 0, total)
	for _, it := range items {
		out = append(out, EncodeItem(it)...)
	}
	return out
}

func encodeAtomHeader(name string, total int) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint32(out[0:4], uint32(total))
	copy(out[4:8], name)
	return out
}

func encodeDataChunk(kind DataType, data []byte) []byte {
	total := 16 + len(data)
	out := make([]byte, total)
	binary.BigEndian.PutUint32(out[0:4], uint32(total))
	copy(out[4:8], []byte("data"))
	binary.BigEndian.PutUint32(out[8:12], uint32(kind))
	copy(out[16:], data)
	return out
}

func encodeFreeformChunk(name, value string) []byte {
	total := 12 + len(value)
	out := make([]byte, total)
	binary.BigEndian.PutUint32(out[0:4], uint32(total))
	copy(out[4:8], name)
	copy(out[12:], value)
	return out
}

// TopLevelAtom is a minimal description of one top-level atom in
// the file, returned by [WalkTopLevel].
type TopLevelAtom struct {
	Name     [4]byte
	Offset   int64 // absolute byte offset of the atom header
	Size     int64 // total atom length (header + body)
	DataAt   int64 // absolute offset of the first body byte
	DataSize int64
}

// WalkTopLevel returns every top-level atom in r, in file order.
// Returns the atoms it parsed up to a malformed entry without an
// error so callers can inspect partial results.
func WalkTopLevel(r io.ReaderAt, size int64) []TopLevelAtom {
	var out []TopLevelAtom
	cursor := int64(0)
	for cursor+8 <= size {
		loc, err := readAtomHeader(r, cursor, size)
		if err != nil {
			return out
		}
		out = append(out, TopLevelAtom{
			Name:     loc.atomType,
			Offset:   cursor,
			Size:     loc.size,
			DataAt:   loc.dataAt,
			DataSize: loc.dataSize,
		})
		cursor += loc.size
	}
	return out
}

// RewriteMoovWithILST takes the body of a moov atom and a fresh
// ilst body, and returns a new moov body whose udta/meta/ilst
// chain has been replaced. Sizes of every container atom along the
// path (ilst, meta, udta) are recomputed; the moov outer header is
// the caller's responsibility.
func RewriteMoovWithILST(moovBody, newILSTBody []byte) ([]byte, error) {
	return RewriteMoovWithMetadata(moovBody, newILSTBody, nil, false)
}

// RewriteMoovWithMetadata rewrites the ilst atom and, optionally, the
// Nero-style udta/chpl chapter atom.
func RewriteMoovWithMetadata(moovBody, newILSTBody, newChplBody []byte, mutateChpl bool) ([]byte, error) {
	udtaBefore, udtaBody, udtaAfter, ok := splitChildAtom(moovBody, "udta")
	if !ok {
		return nil, fmt.Errorf("mp4: moov has no udta atom")
	}
	metaBefore, metaBody, metaAfter, ok := splitChildAtom(udtaBody, "meta")
	if !ok {
		return nil, fmt.Errorf("mp4: udta has no meta atom")
	}
	if len(metaBody) < 4 {
		return nil, fmt.Errorf("mp4: meta atom too short for full-atom prefix")
	}
	metaVerFlags := metaBody[:4]
	metaChildren := metaBody[4:]

	newMetaChildren := replaceOrAppendChildAtom(metaChildren, "ilst", newILSTBody)
	newMetaBody := append(append([]byte{}, metaVerFlags...), newMetaChildren...)
	newUDTABody := wrapChildAtom(metaBefore, metaAfter, "meta", newMetaBody)
	if mutateChpl {
		newUDTABody = replaceOrRemoveChildAtom(newUDTABody, "chpl", newChplBody)
	}
	newMoovBody := wrapChildAtom(udtaBefore, udtaAfter, "udta", newUDTABody)
	if mutateChpl {
		newMoovBody = stripChapterTrackRefs(newMoovBody)
	}
	return newMoovBody, nil
}

// PatchSampleOffsets walks moovBody recursively, finding every
// stco / co64 atom and adding delta to each offset entry. Used
// after a moov rewrite that shifts the byte position of mdat (and
// therefore every sample-table reference into it).
func PatchSampleOffsets(moovBody []byte, delta int64) {
	patchSampleOffsetsRec(moovBody, delta)
}

// splitChildAtom finds the first child atom named name inside body
// and returns the bytes split into [before, child_body, after].
// 64-bit-size atoms (size == 1 + 8-byte extended size) are handled.
func splitChildAtom(body []byte, name string) (before, childBody, after []byte, ok bool) {
	cur := 0
	for cur+8 <= len(body) {
		size := int(binary.BigEndian.Uint32(body[cur : cur+4]))
		atype := string(body[cur+4 : cur+8])
		hdrLen := 8
		switch {
		case size == 1:
			if cur+16 > len(body) {
				return nil, nil, nil, false
			}
			size = int(binary.BigEndian.Uint64(body[cur+8 : cur+16]))
			hdrLen = 16
		case size == 0:
			size = len(body) - cur
		}
		if size < hdrLen || cur+size > len(body) {
			return nil, nil, nil, false
		}
		if atype == name {
			return body[:cur], body[cur+hdrLen : cur+size], body[cur+size:], true
		}
		cur += size
	}
	return nil, nil, nil, false
}

// wrapChildAtom rebuilds a parent body by sandwiching a fresh
// 8-byte-headered child between the supplied before / after spans.
func wrapChildAtom(before, after []byte, name string, body []byte) []byte {
	total := 8 + len(body)
	out := make([]byte, 0, len(before)+total+len(after))
	out = append(out, before...)
	var hdr [8]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(total))
	copy(hdr[4:8], name)
	out = append(out, hdr[:]...)
	out = append(out, body...)
	out = append(out, after...)
	return out
}

func replaceOrAppendChildAtom(body []byte, name string, childBody []byte) []byte {
	before, _, after, ok := splitChildAtom(body, name)
	if ok {
		return wrapChildAtom(before, after, name, childBody)
	}
	return wrapChildAtom(body, nil, name, childBody)
}

func replaceOrRemoveChildAtom(body []byte, name string, childBody []byte) []byte {
	before, _, after, ok := splitChildAtom(body, name)
	if !ok {
		if len(childBody) == 0 {
			return append([]byte(nil), body...)
		}
		return wrapChildAtom(body, nil, name, childBody)
	}
	if len(childBody) == 0 {
		out := make([]byte, 0, len(before)+len(after))
		out = append(out, before...)
		out = append(out, after...)
		return out
	}
	return wrapChildAtom(before, after, name, childBody)
}

// stripChapterTrackRefs removes "chap" entries from every trak/tref
// atom in moovBody, so that ReadChapters falls back to the Nero chpl
// atom after a SetChapters rewrite.
func stripChapterTrackRefs(moovBody []byte) []byte {
	var result []byte
	cur := 0
	changed := false
	for cur+8 <= len(moovBody) {
		size, hdrLen := atomSizeAndHeader(moovBody, cur)
		if size < hdrLen || cur+size > len(moovBody) {
			break
		}
		atype := string(moovBody[cur+4 : cur+8])
		if atype == "trak" {
			trakBody := moovBody[cur+hdrLen : cur+size]
			newTrakBody := stripChapFromTref(trakBody)
			if len(newTrakBody) != len(trakBody) {
				if result == nil {
					result = make([]byte, 0, len(moovBody))
					result = append(result, moovBody[:cur]...)
				}
				var hdr [8]byte
				binary.BigEndian.PutUint32(hdr[:4], uint32(8+len(newTrakBody)))
				copy(hdr[4:8], "trak")
				result = append(result, hdr[:]...)
				result = append(result, newTrakBody...)
				changed = true
				cur += size
				continue
			}
		}
		if result != nil {
			result = append(result, moovBody[cur:cur+size]...)
		}
		cur += size
	}
	if !changed {
		return moovBody
	}
	if cur < len(moovBody) {
		result = append(result, moovBody[cur:]...)
	}
	return result
}

func stripChapFromTref(trakBody []byte) []byte {
	before, trefBody, after, ok := splitChildAtom(trakBody, "tref")
	if !ok {
		return trakBody
	}
	newTrefBody := removeChildAtom(trefBody, "chap")
	if len(newTrefBody) == len(trefBody) {
		return trakBody
	}
	if len(newTrefBody) == 0 {
		// Empty tref: remove it entirely.
		out := make([]byte, 0, len(before)+len(after))
		out = append(out, before...)
		out = append(out, after...)
		return out
	}
	return wrapChildAtom(before, after, "tref", newTrefBody)
}

func removeChildAtom(body []byte, name string) []byte {
	before, _, after, ok := splitChildAtom(body, name)
	if !ok {
		return body
	}
	out := make([]byte, 0, len(before)+len(after))
	out = append(out, before...)
	out = append(out, after...)
	return out
}

func atomSizeAndHeader(body []byte, cur int) (size, hdrLen int) {
	if cur+8 > len(body) {
		return 0, 8
	}
	size = int(binary.BigEndian.Uint32(body[cur : cur+4]))
	hdrLen = 8
	switch {
	case size == 1:
		if cur+16 > len(body) {
			return 0, 16
		}
		size = int(binary.BigEndian.Uint64(body[cur+8 : cur+16]))
		hdrLen = 16
	case size == 0:
		size = len(body) - cur
	}
	return size, hdrLen
}

// patchSampleOffsetsRec walks an atom body, descending into known
// container atoms, and bumps stco / co64 entries by delta.
func patchSampleOffsetsRec(body []byte, delta int64) {
	cur := 0
	for cur+8 <= len(body) {
		size := int(binary.BigEndian.Uint32(body[cur : cur+4]))
		atype := string(body[cur+4 : cur+8])
		hdrLen := 8
		switch {
		case size == 1:
			if cur+16 > len(body) {
				return
			}
			size = int(binary.BigEndian.Uint64(body[cur+8 : cur+16]))
			hdrLen = 16
		case size == 0:
			size = len(body) - cur
		}
		if size < hdrLen || cur+size > len(body) {
			return
		}
		switch atype {
		case "stco":
			// 4 bytes version+flags, 4 bytes count, count×4 bytes
			// of unsigned offsets into the file.
			if cur+hdrLen+8 <= cur+size {
				count := binary.BigEndian.Uint32(body[cur+hdrLen+4 : cur+hdrLen+8])
				for i := uint32(0); i < count; i++ {
					pos := cur + hdrLen + 8 + int(i)*4
					if pos+4 > cur+size {
						break
					}
					old := binary.BigEndian.Uint32(body[pos : pos+4])
					binary.BigEndian.PutUint32(body[pos:pos+4], uint32(int64(old)+delta))
				}
			}
		case "co64":
			if cur+hdrLen+8 <= cur+size {
				count := binary.BigEndian.Uint32(body[cur+hdrLen+4 : cur+hdrLen+8])
				for i := uint32(0); i < count; i++ {
					pos := cur + hdrLen + 8 + int(i)*8
					if pos+8 > cur+size {
						break
					}
					old := binary.BigEndian.Uint64(body[pos : pos+8])
					binary.BigEndian.PutUint64(body[pos:pos+8], uint64(int64(old)+delta))
				}
			}
		case "moov", "trak", "mdia", "minf", "stbl", "edts", "udta":
			patchSampleOffsetsRec(body[cur+hdrLen:cur+size], delta)
		}
		cur += size
	}
}
