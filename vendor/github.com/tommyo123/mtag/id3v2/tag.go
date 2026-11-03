package id3v2

import (
	"bytes"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
)

// HeaderSize is the fixed ten-byte size of an ID3v2 tag header.
const HeaderSize = 10

// MaxPaddingPreserved caps how much zero-byte padding mtag will
// reproduce on rewrite. The original tag size is still respected for
// shrink-fit; only the reported padding budget is clipped.
const MaxPaddingPreserved = 1 << 20 // 1 MiB

// Header is the decoded ten-byte tag header.
type Header struct {
	Major    byte
	Revision byte
	Flags    byte
	// Size is the tag's byte length as declared in the header. This
	// is the size of the extended header + frames + padding, i.e. it
	// excludes the header itself and the optional footer.
	Size uint32
}

// Tag header flag masks (bit 7 to bit 0).
const (
	flagUnsynchronised = 0x80
	flagExtendedHeader = 0x40
	flagExperimental   = 0x20
	flagFooterPresent  = 0x10 // v2.4 only
	flagCompression23  = 0x40 // v2.2 "compression" bit (must be zero)
)

// Magic values.
var (
	magicID3 = [3]byte{'I', 'D', '3'}
	magic3DI = [3]byte{'3', 'D', 'I'}
)

// ErrNoTag is returned when the expected ID3v2 header is missing.
var ErrNoTag = errors.New("id3v2: tag not present")

// ExtendedHeader is the subset of ID3v2's optional extended-header
// metadata that mtag preserves on round-trip.
type ExtendedHeader struct {
	Present bool

	// Update is the v2.4 "tag is an update" bit.
	Update bool

	// CRCPresent records whether the extended header carries a CRC.
	// CRC holds the parsed value as read; writers always regenerate it.
	CRCPresent bool
	CRC        uint32

	// RestrictionsPresent / Restrictions are the v2.4 tag-restrictions
	// block. The raw bitfield is preserved unchanged.
	RestrictionsPresent bool
	Restrictions        byte
}

// Tag is an in-memory representation of an ID3v2 tag.
type Tag struct {
	// Version is the major version (2, 3 or 4) assigned to this tag.
	// Serialize uses this to pick the correct frame
	// format. Callers may change it to transcode between versions.
	Version  byte
	Revision byte
	// Unsynchronised is set if the tag was originally stored with
	// tag-level unsynchronisation. Serialize emits the flag but
	// only if actually needed.
	Unsynchronised bool
	// Experimental mirrors the header flag. It has no effect on
	// mtag's behaviour and is preserved for round-tripping.
	Experimental bool
	// ExtendedHeader preserves the optional extended-header fields we
	// understand: CRC, update flag and v2.4 restrictions.
	ExtendedHeader ExtendedHeader
	// Frames are stored in the order they should appear on disk.
	Frames []Frame
	// Padding is the number of zero bytes between the last frame
	// and the declared tag size, as read. Serialize uses this as a
	// hint when writing in place.
	Padding int
	// OriginalSize is the byte length of the tag as read, including
	// the ten-byte header. Zero for tags that were synthesised in
	// memory.
	OriginalSize int64

	// idIndex maps a canonical frame ID to every matching position
	// in Frames, making Find / FindAll / Text / Remove O(1) average
	// instead of O(n) per call. It is lazily (re)built by
	// [ensureIndex] on first lookup and invalidated by the typed
	// mutators (Set / Remove / SetText / Merge). Callers that poke
	// Frames directly must call [InvalidateIndex] — or mutate only
	// through the typed API.
	idIndex map[string][]int
	// idIndexLen snapshots len(Frames) at the moment idIndex was
	// built. A mismatch is the cheap staleness check used by
	// [ensureIndex] to catch direct Frames mutation.
	idIndexLen int
}

// InvalidateIndex marks the cached frame-ID index stale so the next
// Find / Text / FindAll call rebuilds it. Callers that mutate
// [Tag.Frames] directly (bypassing Set / Remove / SetText) must
// call this after the mutation; the typed mutators invalidate
// automatically.
func (t *Tag) InvalidateIndex() {
	t.idIndex = nil
	t.idIndexLen = -1
}

// ensureIndex rebuilds idIndex when it is empty or out of sync
// with Frames. The staleness check is intentionally cheap: a
// length mismatch is the common signal after an Add/Remove, and
// that's enough for every mutation path the typed API supports.
func (t *Tag) ensureIndex() {
	if t.idIndex != nil && t.idIndexLen == len(t.Frames) {
		return
	}
	if t.idIndex == nil {
		t.idIndex = make(map[string][]int, len(t.Frames))
	} else {
		for k := range t.idIndex {
			delete(t.idIndex, k)
		}
	}
	for i, f := range t.Frames {
		id := f.ID()
		t.idIndex[id] = append(t.idIndex[id], i)
	}
	t.idIndexLen = len(t.Frames)
}

// ReadHeader parses a ten-byte ID3v2 header. It does not read the
// body.
func ReadHeader(b []byte) (Header, error) {
	if len(b) < HeaderSize {
		return Header{}, ErrNoTag
	}
	if !bytes.Equal(b[:3], magicID3[:]) {
		return Header{}, ErrNoTag
	}
	h := Header{
		Major:    b[3],
		Revision: b[4],
		Flags:    b[5],
		Size:     DecodeSynchsafe(b[6:10]),
	}
	if h.Major == 0xFF || h.Revision == 0xFF {
		return Header{}, fmt.Errorf("id3v2: illegal version bytes")
	}
	if h.Major < 2 || h.Major > 4 {
		return Header{}, fmt.Errorf("%w: ID3v2.%d", errUnsupported, h.Major)
	}
	return h, nil
}

var errUnsupported = errors.New("unsupported major version")

// MaxDecompressedFrameSize caps how many bytes of inflated data a
// single zlib-compressed ID3v2 frame body may expand to. The hard
// cap blocks decompression-bomb inputs from forcing the decoder to
// materialise multi-GB buffers. Legitimate frames compressed in
// real files are well under 1 MiB; the 16 MiB ceiling is generous.
const MaxDecompressedFrameSize = 16 << 20

// MaxTagBodySize caps the number of bytes mtag will allocate for a
// single ID3v2 body when only the tag header is available. Real
// tags, even with large embedded artwork, are usually well below
// this; the cap exists to stop malformed size headers from forcing
// multi-hundred-megabyte allocations before the caller has a chance
// to reject the tag.
const MaxTagBodySize = 64 << 20

// decompressDeflate expands a zlib-deflate stream into memory, up
// to [MaxDecompressedFrameSize] bytes. A stream that inflates past
// the ceiling returns [ErrDecompressedFrameTooLarge] so the caller
// can fall back to the raw-frame view instead of blowing up the
// heap.
func decompressDeflate(b []byte) ([]byte, error) {
	zr, err := zlib.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	// Read one byte beyond the cap so we can tell "reached cap and
	// still had more" from "fit exactly". io.LimitReader truncates
	// silently, which would let a bomb succeed with garbled output.
	lr := io.LimitReader(zr, int64(MaxDecompressedFrameSize)+1)
	out, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if len(out) > MaxDecompressedFrameSize {
		return nil, ErrDecompressedFrameTooLarge
	}
	return out, nil
}

// ErrDecompressedFrameTooLarge is returned when a zlib-compressed
// ID3v2 frame inflates past [MaxDecompressedFrameSize]. The caller
// is expected to fall back to the raw, still-compressed frame body
// rather than corrupting the heap.
var ErrDecompressedFrameTooLarge = errors.New("id3v2: decompressed frame exceeds size cap")

// ErrTagTooLarge is returned when the declared tag body exceeds
// [MaxTagBodySize] or the caller-provided region bound.
var ErrTagTooLarge = errors.New("id3v2: tag body exceeds size cap")

// compressedMaskFor returns the bit position of the "compressed"
// flag in the second flag byte, per the major version.
func compressedMaskFor(version byte) byte {
	switch version {
	case 3:
		return 0x80
	case 4:
		return 0x08
	}
	return 0
}

// clampPadding limits how much padding mtag advertises on the
// returned tag, see [MaxPaddingPreserved].
func clampPadding(n int) int {
	if n > MaxPaddingPreserved {
		return MaxPaddingPreserved
	}
	if n < 0 {
		return 0
	}
	return n
}

// Read parses an ID3v2 tag from r starting at the given offset. It
// reads header + body + optional footer.
func Read(r io.ReaderAt, offset int64) (*Tag, error) {
	return readWithLimit(r, offset, -1)
}

// ReadBounded parses an ID3v2 tag from a bounded region. maxBytes is
// the number of readable bytes available from offset onward.
func ReadBounded(r io.ReaderAt, offset, maxBytes int64) (*Tag, error) {
	return readWithLimit(r, offset, maxBytes)
}

func readWithLimit(r io.ReaderAt, offset, maxBytes int64) (*Tag, error) {
	var hdrBuf [HeaderSize]byte
	if _, err := r.ReadAt(hdrBuf[:], offset); err != nil {
		return nil, fmt.Errorf("id3v2: read header: %w", err)
	}
	hdr, err := ReadHeader(hdrBuf[:])
	if err != nil {
		return nil, err
	}
	bodySize := int64(hdr.Size)
	if bodySize > MaxTagBodySize {
		return nil, ErrTagTooLarge
	}
	total := int64(HeaderSize) + bodySize
	if hdr.Flags&flagFooterPresent != 0 && hdr.Major == 4 {
		total += HeaderSize
	}
	if maxBytes >= 0 && total > maxBytes {
		return nil, ErrTagTooLarge
	}
	// Body is hdr.Size bytes following the header.
	body := make([]byte, hdr.Size)
	if _, err := r.ReadAt(body, offset+HeaderSize); err != nil {
		return nil, fmt.Errorf("id3v2: read body: %w", err)
	}
	return parseTag(hdr, body, total)
}

func parseTag(hdr Header, body []byte, total int64) (*Tag, error) {
	t := &Tag{
		Version:        hdr.Major,
		Revision:       hdr.Revision,
		Unsynchronised: hdr.Flags&flagUnsynchronised != 0,
		Experimental:   hdr.Flags&flagExperimental != 0,
		OriginalSize:   total,
	}

	// Tag-level unsynchronisation only covers the entire tag body
	// in ID3v2.2 and 2.3. In v2.4 the bit is purely informational:
	// it promises that *every* frame carries its own per-frame
	// unsynchronisation flag, and each frame's body must be
	// resynchronised individually. Resynchronising a v2.4 body as
	// a single stream would eat legitimate $FF $00 sequences
	// inside picture frames and other binary payloads.
	if t.Unsynchronised && hdr.Major < 4 {
		body = Resynchronise(body)
	}

	cur := 0

	if hdr.Flags&flagExtendedHeader != 0 && hdr.Major >= 3 {
		ext, consumed, err := parseExtendedHeader(hdr.Major, body)
		if err != nil {
			return nil, err
		}
		t.ExtendedHeader = ext
		cur += consumed
	}

	// Pre-allocate based on average frame size heuristic.
	t.Frames = make([]Frame, 0, max(len(body)/50, 8))

	// Frames.
	for cur < len(body) {
		// Padding begins as soon as we see a zero-byte frame ID.
		if body[cur] == 0 {
			t.Padding = clampPadding(len(body) - cur)
			break
		}
		frame, consumed, err := readOneFrame(hdr.Major, body[cur:])
		if err != nil {
			// A garbled frame past the start of the tag is the
			// most common form of in-the-wild corruption: a
			// tagger truncates a value or writes a junk size,
			// and everything beyond is unreadable. Keep
			// whatever frames we already have and treat the
			// rest as opaque trailing data.
			//
			// If the *first* frame is unreadable the whole tag
			// is effectively gibberish — propagate the error so
			// the caller can decide whether to mark the tag as
			// corrupt or fall back to ID3v1.
			if len(t.Frames) == 0 {
				return nil, err
			}
			t.Padding = clampPadding(len(body) - cur)
			break
		}
		if frame != nil {
			t.Frames = append(t.Frames, frame)
		}
		cur += consumed
	}
	t.resolveEncryptedFrameRegistrations()
	return t, nil
}

// readOneFrame reads a single frame starting at the beginning of b.
// It returns the parsed frame and the number of bytes consumed.
func readOneFrame(version byte, b []byte) (Frame, int, error) {
	var (
		idLen       int
		sizeLen     int
		flagsLen    int
		synchsafe   bool
		upgradeFrom string
	)
	switch version {
	case 2:
		idLen, sizeLen, flagsLen = 3, 3, 0
	case 3:
		idLen, sizeLen, flagsLen = 4, 4, 2
		synchsafe = false
	case 4:
		idLen, sizeLen, flagsLen = 4, 4, 2
		synchsafe = true
	default:
		return nil, 0, fmt.Errorf("id3v2: unsupported major %d", version)
	}
	hdrLen := idLen + sizeLen + flagsLen
	if len(b) < hdrLen {
		return nil, 0, fmt.Errorf("id3v2: truncated frame header")
	}

	rawID := string(b[:idLen])
	// Some taggers wrote v2.2 three-letter frame IDs into a v2.3 or
	// v2.4 container, padding the fourth byte with a NUL or space.
	// Recognise those by checking whether the 3-letter prefix maps
	// to a known v2.2 ID and the 4th byte is non-letter; if so,
	// treat as the canonical 4-letter equivalent.
	if (version == 3 || version == 4) && idLen == 4 {
		if b[3] == 0 || b[3] == ' ' {
			prefix := string(b[:3])
			if up, ok := frameIDUpgrade[prefix]; ok {
				rawID = up
				upgradeFrom = prefix
			}
		}
	}
	var size uint32
	switch sizeLen {
	case 3:
		size = DecodeUint24BE(b[idLen : idLen+3])
	case 4:
		if synchsafe {
			size = DecodeSynchsafe(b[idLen : idLen+4])
		} else {
			size = DecodeUint32BE(b[idLen : idLen+4])
		}
	}
	var flags FrameFlags
	if flagsLen == 2 {
		flags.Raw[0] = b[idLen+sizeLen]
		flags.Raw[1] = b[idLen+sizeLen+1]
		flags.Version = version
	}
	total := hdrLen + int(size)
	if total > len(b) {
		return nil, 0, fmt.Errorf("id3v2: frame %q declares size %d but only %d bytes left", rawID, size, len(b)-hdrLen)
	}
	body := b[hdrLen:total]

	id := rawID
	if version == 2 {
		id = UpgradeFrameID(rawID)
		if id != rawID {
			upgradeFrom = rawID
		}
	}

	// Apply per-frame unsynchronisation (v2.4).
	if flags.Unsynchronised() {
		body = Resynchronise(body)
	}

	var v23DecompressedSize uint32
	if version == 3 && flags.Compressed() {
		if len(body) < 4 {
			return &RawFrame{FrameID: id, Data: append([]byte(nil), b[hdrLen:total]...), FrameFlags: flags, LegacyID: upgradeFrom}, total, nil
		}
		v23DecompressedSize = DecodeUint32BE(body[:4])
		body = body[4:]
	}
	if flags.Encrypted() {
		f, err := parseEncryptedFrame(version, id, body, flags, upgradeFrom, v23DecompressedSize)
		if err != nil {
			return &RawFrame{FrameID: id, Data: append([]byte(nil), b[hdrLen:total]...), FrameFlags: flags, LegacyID: upgradeFrom}, total, nil
		}
		return f, total, nil
	}
	// Skip data length indicator prefix (v2.4).
	if flags.HasDataLengthIndicator() && len(body) >= 4 {
		body = body[4:]
	}
	// Compressed (zlib-deflate) frames are uncommon but legal.
	// Decompress so the typed parsers below see a real body. The
	// Compressed flag is left set on the [FrameFlags] so writers
	// can choose to re-compress the body on save. If decompression
	// fails we fall back to the raw byte view rather than dropping
	// the frame.
	if flags.Compressed() {
		if dec, err := decompressDeflate(body); err == nil {
			body = dec
		} else {
			return &RawFrame{FrameID: upgradeID(version, rawID), Data: append([]byte(nil), body...), FrameFlags: flags, LegacyID: legacyID(version, rawID)}, total, nil
		}
	}
	// Special case: v2.2 PIC is not a straight rename of APIC.
	if version == 2 && rawID == "PIC" {
		f, err := parsePictureV22(body, flags)
		if err != nil {
			return &RawFrame{FrameID: id, Data: append([]byte(nil), body...), FrameFlags: flags, LegacyID: upgradeFrom}, total, nil
		}
		return f, total, nil
	}

	frame, err := parseFrameBody(id, body, flags)
	if err != nil {
		// Fall back to raw so we never lose data.
		return &RawFrame{FrameID: id, Data: append([]byte(nil), body...), FrameFlags: flags, LegacyID: upgradeFrom}, total, nil
	}
	return frame, total, nil
}

func parseExtendedHeader(version byte, body []byte) (ExtendedHeader, int, error) {
	switch version {
	case 3:
		return parseExtendedHeaderV23(body)
	case 4:
		return parseExtendedHeaderV24(body)
	default:
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: extended header unsupported for v2.%d", version)
	}
}

func parseExtendedHeaderV23(body []byte) (ExtendedHeader, int, error) {
	if len(body) < 10 {
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: truncated extended header")
	}
	size := int(DecodeUint32BE(body[:4])) + 4
	if size < 10 || size > len(body) {
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: extended header larger than tag")
	}
	flags := uint16(body[4])<<8 | uint16(body[5])
	out := ExtendedHeader{Present: true}
	if flags&0x8000 != 0 {
		if size < 14 {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: short extended-header CRC")
		}
		out.CRCPresent = true
		out.CRC = DecodeUint32BE(body[10:14])
	}
	return out, size, nil
}

func parseExtendedHeaderV24(body []byte) (ExtendedHeader, int, error) {
	if len(body) < 6 {
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: truncated extended header")
	}
	size := int(DecodeSynchsafe(body[:4]))
	if size < 6 || size > len(body) {
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: extended header larger than tag")
	}
	nFlagBytes := int(body[4])
	if nFlagBytes < 1 || 5+nFlagBytes > size {
		return ExtendedHeader{}, 0, fmt.Errorf("id3v2: malformed extended header flag bytes")
	}
	out := ExtendedHeader{Present: true}
	flags := body[5]
	cur := 5 + nFlagBytes
	if flags&0x40 != 0 {
		if cur >= size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: short extended-header update flag")
		}
		n := int(body[cur])
		cur++
		if cur+n > size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: truncated extended-header update data")
		}
		out.Update = true
		cur += n
	}
	if flags&0x20 != 0 {
		if cur >= size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: short extended-header CRC flag")
		}
		n := int(body[cur])
		cur++
		if n != 5 || cur+n > size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: malformed extended-header CRC")
		}
		out.CRCPresent = true
		out.CRC = decodeSynchsafe35(body[cur : cur+n])
		cur += n
	}
	if flags&0x10 != 0 {
		if cur >= size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: short extended-header restrictions flag")
		}
		n := int(body[cur])
		cur++
		if n != 1 || cur+n > size {
			return ExtendedHeader{}, 0, fmt.Errorf("id3v2: malformed extended-header restrictions")
		}
		out.RestrictionsPresent = true
		out.Restrictions = body[cur]
		cur += n
	}
	return out, size, nil
}

func parseEncryptedFrame(version byte, id string, body []byte, flags FrameFlags, legacyID string, v23DecompressedSize uint32) (Frame, error) {
	out := &EncryptedFrame{
		FrameID:             id,
		LegacyID:            legacyID,
		MethodID:            0,
		FrameFlags:          flags,
		DecompressedSize:    v23DecompressedSize,
		HasDecompressedSize: version == 3 && flags.Compressed(),
	}
	cur := 0
	switch version {
	case 3:
		if cur >= len(body) {
			return nil, fmt.Errorf("id3v2: encrypted frame missing method byte")
		}
		out.MethodID = body[cur]
		cur++
		if flags.Grouped() {
			if cur >= len(body) {
				return nil, fmt.Errorf("id3v2: encrypted frame missing group byte")
			}
			out.GroupSymbol = body[cur]
			out.HasGroupSymbol = true
			cur++
		}
	case 4:
		if flags.Grouped() {
			if cur >= len(body) {
				return nil, fmt.Errorf("id3v2: encrypted frame missing group byte")
			}
			out.GroupSymbol = body[cur]
			out.HasGroupSymbol = true
			cur++
		}
		if cur >= len(body) {
			return nil, fmt.Errorf("id3v2: encrypted frame missing method byte")
		}
		out.MethodID = body[cur]
		cur++
		if flags.HasDataLengthIndicator() {
			if cur+4 > len(body) {
				return nil, fmt.Errorf("id3v2: encrypted frame missing data length indicator")
			}
			out.DataLengthIndicator = DecodeSynchsafe(body[cur : cur+4])
			out.HasDataLengthIndicator = true
			cur += 4
		}
	default:
		return nil, fmt.Errorf("id3v2: encrypted frame unsupported in v2.%d", version)
	}
	out.Data = append([]byte(nil), body[cur:]...)
	return out, nil
}

func decodeSynchsafe35(b []byte) uint32 {
	if len(b) < 5 {
		return 0
	}
	return uint32(b[0]&0x7F)<<28 |
		uint32(b[1]&0x7F)<<21 |
		uint32(b[2]&0x7F)<<14 |
		uint32(b[3]&0x7F)<<7 |
		uint32(b[4]&0x7F)
}

func (t *Tag) resolveEncryptedFrameRegistrations() {
	if len(t.Frames) == 0 {
		return
	}
	methods := make(map[byte]*EncryptionRegistrationFrame)
	for _, fr := range t.Frames {
		if reg, ok := fr.(*EncryptionRegistrationFrame); ok {
			methods[reg.MethodID] = reg
		}
	}
	if len(methods) == 0 {
		return
	}
	for _, fr := range t.Frames {
		if enc, ok := fr.(*EncryptedFrame); ok {
			enc.Registration = methods[enc.MethodID]
		}
	}
}

func upgradeID(version byte, id string) string {
	if version == 2 {
		return UpgradeFrameID(id)
	}
	return id
}

func legacyID(version byte, id string) string {
	if version == 2 {
		up := UpgradeFrameID(id)
		if up == id {
			return id // no canonical upgrade existed
		}
		return id
	}
	return ""
}

// All yields every frame in the tag, in declaration order. Designed
// for the Go 1.23 range-over-func form:
//
//	for f := range tag.All() {
//	    fmt.Println(f.ID())
//	}
func (t *Tag) All() func(yield func(Frame) bool) {
	return func(yield func(Frame) bool) {
		for _, f := range t.Frames {
			if !yield(f) {
				return
			}
		}
	}
}

// Where yields every frame whose ID equals id. Equivalent to
// FindAll but composes naturally with range loops:
//
//	for f := range tag.Where(id3v2.FrameComment) {
//	    ...
//	}
func (t *Tag) Where(id string) func(yield func(Frame) bool) {
	return func(yield func(Frame) bool) {
		for _, f := range t.Frames {
			if f.ID() == id && !yield(f) {
				return
			}
		}
	}
}

// Find returns the first frame with the given canonical ID.
func (t *Tag) Find(id string) Frame {
	t.ensureIndex()
	idx := t.idIndex[id]
	if len(idx) == 0 {
		return nil
	}
	return t.Frames[idx[0]]
}

// FindAll returns every frame with the given canonical ID, in
// declaration order.
func (t *Tag) FindAll(id string) []Frame {
	t.ensureIndex()
	idx := t.idIndex[id]
	if len(idx) == 0 {
		return nil
	}
	out := make([]Frame, 0, len(idx))
	for _, i := range idx {
		out = append(out, t.Frames[i])
	}
	return out
}

// Remove drops every frame whose ID matches id. It returns the
// number of frames removed.
func (t *Tag) Remove(id string) int {
	n := 0
	kept := t.Frames[:0]
	for _, f := range t.Frames {
		if f.ID() == id {
			n++
			continue
		}
		kept = append(kept, f)
	}
	t.Frames = kept
	if n > 0 {
		t.InvalidateIndex()
	}
	return n
}

// Set adds frame to the tag, replacing any existing frames with the
// same ID. A nil frame is ignored; use Remove to delete frames by ID.
func (t *Tag) Set(frame Frame) {
	if frame == nil {
		return
	}
	id := frame.ID()
	t.Remove(id)
	t.Frames = append(t.Frames, frame)
	t.InvalidateIndex()
}

// Merge folds every frame in other into t. This handles files with
// several prepended ID3v2 tags:
//
//   - Single-value frames (T*** except TXXX, W*** except WXXX, and a
//     handful of bookkeeping frames) use FIRST-WINS semantics: the
//     earliest tag in the chain keeps its value, so the "primary"
//     tag wins over later auto-generated ones.
//   - Multi-value frames (APIC, COMM, USLT, TXXX, WXXX, PRIV, GEOB,
//     UFID, POPM …) always accumulate. A front cover from the first
//     tag plus a band-logo from the second both survive.
//
// Version/revision track the most-recent tag in the chain so the
// next Encode uses that dialect; this is only a serialisation hint
// and does not affect which frame values won.
//
// A strict reading of the v2.4 spec says the most recent tag should
// fully replace earlier ones, but in practice that is contradicted
// by how taggers stack fixups onto an original tag; first-wins is
// the behaviour every popular player follows.
func (t *Tag) Merge(other *Tag) {
	if other == nil {
		return
	}
	// v2.4 extended-header "Tag is an update": per the spec, frames
	// defined as unique in the incoming tag override any
	// corresponding ones in the earlier tag. We honour that
	// explicitly when the flag is set; without the flag the default
	// first-wins policy applies, matching how every popular player
	// reads stacked tags in the wild.
	updateWins := other.ExtendedHeader.Present && other.ExtendedHeader.Update
	if updateWins {
		incomingSingle := make(map[string]bool)
		for _, f := range other.Frames {
			id := f.ID()
			if isSingleValueFrame(id) {
				incomingSingle[id] = true
			}
		}
		// Drop earlier copies of any single-value frame the update
		// tag will replace.
		filtered := t.Frames[:0]
		for _, f := range t.Frames {
			if incomingSingle[f.ID()] {
				continue
			}
			filtered = append(filtered, f)
		}
		t.Frames = filtered
	}
	existingSingle := make(map[string]bool)
	for _, f := range t.Frames {
		id := f.ID()
		if isSingleValueFrame(id) {
			existingSingle[id] = true
		}
	}
	for _, f := range other.Frames {
		id := f.ID()
		if isSingleValueFrame(id) && existingSingle[id] {
			continue // first-wins (or already-merged update): keep t's value
		}
		t.Frames = append(t.Frames, f)
		if isSingleValueFrame(id) {
			existingSingle[id] = true
		}
	}
	t.InvalidateIndex()
	t.Version = other.Version
	t.Revision = other.Revision
	if other.Unsynchronised {
		t.Unsynchronised = true
	}
	if other.Experimental {
		t.Experimental = true
	}
	if other.ExtendedHeader.Present {
		t.ExtendedHeader = other.ExtendedHeader
	}
}

// isSingleValueFrame reports whether id names a frame the ID3 spec
// requires to be unique within a single tag. mtag uses this to
// decide whether Merge should overwrite or append.
func isSingleValueFrame(id string) bool {
	if id == FrameUserText || id == FrameUserURL {
		return false
	}
	if len(id) == 4 && (id[0] == 'T' || id[0] == 'W') {
		return true
	}
	switch id {
	case "MCDI", "PCNT", "IPLS", "TIPL", "TMCL",
		"SEEK", "ASPI", "SYTC", "MLLT",
		"RBUF", "USER", "OWNE", "POSS":
		return true
	}
	return false
}

// SetText is a convenience wrapper that writes a text frame with
// the given values. An empty values list removes the frame.
func (t *Tag) SetText(id string, values ...string) {
	if len(values) == 0 || (len(values) == 1 && values[0] == "") {
		t.Remove(id)
		return
	}
	t.Set(&TextFrame{FrameID: id, Values: values})
}

// Text returns the first value of the first frame with id, or "" if
// no such frame exists. For non-text frames the empty string is
// returned.
func (t *Tag) Text(id string) string {
	f := t.Find(id)
	if f == nil {
		return ""
	}
	if tf, ok := f.(*TextFrame); ok && len(tf.Values) > 0 {
		return tf.Values[0]
	}
	return ""
}
