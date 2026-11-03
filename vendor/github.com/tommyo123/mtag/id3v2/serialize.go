package id3v2

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"hash/crc32"
)

// Encode produces the byte representation of the tag for the major
// version stored in t.Version. The returned slice begins
// with the ten-byte header. When padding > 0 that many zero bytes
// are appended after the last frame; callers that want in-place
// rewrites use this to pad out to the original size.
func (t *Tag) Encode(padding int) ([]byte, error) {
	if t.Version < 2 || t.Version > 4 {
		return nil, fmt.Errorf("id3v2: cannot encode version %d", t.Version)
	}

	frames, err := t.encodeFrames()
	if err != nil {
		return nil, err
	}
	ext, extFlags, err := t.encodeExtendedHeader(frames, padding)
	if err != nil {
		return nil, err
	}
	body := make([]byte, 0, len(ext)+len(frames)+padding)
	body = append(body, ext...)
	body = append(body, frames...)
	if padding > 0 {
		body = append(body, make([]byte, padding)...)
	}

	flags := extFlags
	if t.Experimental {
		flags |= flagExperimental
	}
	// Tag-level unsynchronisation only rewrites the tag body in
	// v2.2/v2.3. In v2.4 the header bit is informational: the actual
	// escaping lives on individual frames.
	if t.Unsynchronised {
		flags |= flagUnsynchronised
		if t.Version < 4 {
			un := Unsynchronise(body)
			if len(un) != len(body) {
				body = un
			}
		}
	}

	if len(body) >= 1<<28 {
		return nil, fmt.Errorf("id3v2: tag body too large (%d bytes)", len(body))
	}

	out := make([]byte, HeaderSize+len(body))
	copy(out[:3], magicID3[:])
	out[3] = t.Version
	out[4] = t.Revision
	out[5] = flags
	if err := EncodeSynchsafe(out[6:10], uint32(len(body))); err != nil {
		return nil, err
	}
	copy(out[HeaderSize:], body)
	return out, nil
}

func (t *Tag) encodeExtendedHeader(frames []byte, padding int) ([]byte, byte, error) {
	if !t.ExtendedHeader.Present || t.Version < 3 {
		return nil, 0, nil
	}
	switch t.Version {
	case 3:
		ext, err := t.encodeExtendedHeaderV23(frames, padding)
		if err != nil {
			return nil, 0, err
		}
		return ext, flagExtendedHeader, nil
	case 4:
		ext, err := t.encodeExtendedHeaderV24(frames, padding)
		if err != nil {
			return nil, 0, err
		}
		return ext, flagExtendedHeader, nil
	}
	return nil, 0, nil
}

func (t *Tag) encodeExtendedHeaderV23(frames []byte, padding int) ([]byte, error) {
	sizeAfterField := uint32(6)
	if t.ExtendedHeader.CRCPresent {
		sizeAfterField += 4
	}
	out := make([]byte, 4+sizeAfterField)
	EncodeUint32BE(out[:4], sizeAfterField)
	if t.ExtendedHeader.CRCPresent {
		out[4] = 0x80
	}
	EncodeUint32BE(out[6:10], uint32(padding))
	if t.ExtendedHeader.CRCPresent {
		crc := crc32.ChecksumIEEE(frames)
		EncodeUint32BE(out[10:14], crc)
	}
	return out, nil
}

func (t *Tag) encodeExtendedHeaderV24(frames []byte, padding int) ([]byte, error) {
	flags := byte(0)
	extras := make([]byte, 0, 10)
	if t.ExtendedHeader.Update {
		flags |= 0x40
		extras = append(extras, 0)
	}
	if t.ExtendedHeader.CRCPresent {
		flags |= 0x20
		extras = append(extras, 5)
		var crcBuf [5]byte
		encodeSynchsafe35(crcBuf[:], crc32WithPadding(frames, padding))
		extras = append(extras, crcBuf[:]...)
	}
	if t.ExtendedHeader.RestrictionsPresent {
		flags |= 0x10
		extras = append(extras, 1, t.ExtendedHeader.Restrictions)
	}
	size := 6 + len(extras)
	out := make([]byte, size)
	if err := EncodeSynchsafe(out[:4], uint32(size)); err != nil {
		return nil, err
	}
	out[4] = 1
	out[5] = flags
	copy(out[6:], extras)
	return out, nil
}

func crc32WithPadding(frames []byte, padding int) uint32 {
	h := crc32.NewIEEE()
	_, _ = h.Write(frames)
	if padding > 0 {
		var zeros [1024]byte
		for padding > 0 {
			n := padding
			if n > len(zeros) {
				n = len(zeros)
			}
			_, _ = h.Write(zeros[:n])
			padding -= n
		}
	}
	return h.Sum32()
}

func encodeSynchsafe35(dst []byte, v uint32) {
	if len(dst) < 5 {
		return
	}
	dst[0] = byte((v >> 28) & 0x7F)
	dst[1] = byte((v >> 21) & 0x7F)
	dst[2] = byte((v >> 14) & 0x7F)
	dst[3] = byte((v >> 7) & 0x7F)
	dst[4] = byte(v & 0x7F)
}

func (t *Tag) encodeFrames() ([]byte, error) {
	var buf bytes.Buffer
	for _, f := range t.Frames {
		id, body, err := t.renderFrame(f)
		if err != nil {
			return nil, err
		}
		if id == "" {
			continue // frame has no representation in this version
		}
		flags := f.Flags()
		recompress := flags.Version == t.Version && flags.Compressed() && (t.Version == 3 || t.Version == 4)
		if recompress {
			body, err = recompressFrame(body, t.Version)
			if err != nil {
				return nil, err
			}
		}
		body, flags, err = applyFrameWriteFormat(f, body, flags, t.Version)
		if err != nil {
			return nil, err
		}
		if err := writeFrameHeader(&buf, t.Version, id, len(body), flags); err != nil {
			return nil, err
		}
		buf.Write(body)
	}
	return buf.Bytes(), nil
}

// applyFrameWriteFormat adds the frame-body prefixes implied by the
// v2.4 per-frame format flags when the typed frame body does not
// already include them.
func applyFrameWriteFormat(f Frame, body []byte, flags FrameFlags, version byte) ([]byte, FrameFlags, error) {
	if version != 4 {
		return body, flags, nil
	}
	switch f.(type) {
	case *RawFrame, *EncryptedFrame:
		// RawFrame carries its opaque body as-is. EncryptedFrame.Body
		// already serialises its own group / method / DLI prefixes and
		// applies per-frame unsynchronisation when requested.
		return body, flags, nil
	}
	if flags.Version != 4 {
		return body, flags, nil
	}
	if flags.HasDataLengthIndicator() && !flags.Compressed() {
		var sz [4]byte
		if err := EncodeSynchsafe(sz[:], uint32(len(body))); err != nil {
			return nil, flags, err
		}
		body = append(sz[:], body...)
	}
	if flags.Unsynchronised() {
		body = Unsynchronise(body)
	}
	return body, flags, nil
}

// recompressFrame zlib-compresses body and prepends the decompressed
// length indicator per ID3v2 version convention. v2.3 uses a 4-byte
// big-endian prefix; v2.4 uses a synchsafe 4-byte DLI and requires
// the DLI flag to be set (the caller controls that via remapFlags).
func recompressFrame(body []byte, version byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write(body); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	prefix := make([]byte, 4)
	switch version {
	case 3:
		binary.BigEndian.PutUint32(prefix, uint32(len(body)))
	case 4:
		if err := EncodeSynchsafe(prefix, uint32(len(body))); err != nil {
			return nil, err
		}
	}
	out := make([]byte, 0, 4+buf.Len())
	out = append(out, prefix...)
	out = append(out, buf.Bytes()...)
	return out, nil
}

func (t *Tag) renderFrame(f Frame) (string, []byte, error) {
	canonical := f.ID()
	id := canonical

	// Translate for target version.
	switch t.Version {
	case 2:
		id = DowngradeFrameID(canonical)
		if id == "" {
			if rf, ok := f.(*RawFrame); ok && rf.LegacyID != "" && len(rf.LegacyID) == 3 {
				id = rf.LegacyID
			} else {
				// Cannot express this frame in v2.2.
				return "", nil, nil
			}
		}
	case 3:
		// v2.4-only frames need remapping or dropping.
		switch canonical {
		case "TDRC", "TDOR":
			// TDRC / TDOR hold an ISO 8601 timestamp but the v2.3
			// equivalents (TYER / TORY) are strictly a 4-digit
			// year, so every value must be truncated on the way
			// down. Rendering a bare TYER frame is the only sound
			// subset conversion; the date/time components from
			// TDRC could in principle fan out to TDAT/TIME but
			// few players understand those anyway.
			targetID := "TYER"
			if canonical == "TDOR" {
				targetID = "TORY"
			}
			body, err := renderYearOnly(targetID, f, t.Version)
			return targetID, body, err
		case "TDRL", "TDTG", "TDEN":
			// No v2.3 equivalent; drop.
			return "", nil, nil
		case "TMCL", "TIPL":
			id = "IPLS"
		case "EQU2":
			id = "EQUA"
		case "RVA2":
			id = "RVAD"
		}
	case 4:
		// v2.3-only frames that have been replaced in v2.4.
		switch canonical {
		case "TYER":
			id = "TDRC"
		case "TORY":
			id = "TDOR"
		case "TDAT", "TIME", "TRDA", "TSIZ":
			// Subsumed into TDRC or removed; drop.
			return "", nil, nil
		case "IPLS":
			id = "TIPL"
		case "EQUA":
			id = "EQU2"
		case "RVAD":
			id = "RVA2"
		}
	}

	body, err := f.Body(t.Version)
	if err != nil {
		return "", nil, err
	}
	return id, body, nil
}

func writeFrameHeader(w *bytes.Buffer, version byte, id string, size int, flags FrameFlags) error {
	switch version {
	case 2:
		if len(id) != 3 {
			return fmt.Errorf("id3v2: frame ID %q is not 3 chars", id)
		}
		w.WriteString(id)
		if size >= 1<<24 {
			return fmt.Errorf("id3v2: frame %s too large for v2.2", id)
		}
		var sz [3]byte
		EncodeUint24BE(sz[:], uint32(size))
		w.Write(sz[:])
	case 3:
		if len(id) != 4 {
			return fmt.Errorf("id3v2: frame ID %q is not 4 chars", id)
		}
		w.WriteString(id)
		var sz [4]byte
		EncodeUint32BE(sz[:], uint32(size))
		w.Write(sz[:])
		// Translate flags from their source version to v2.3 bit
		// positions. For simplicity we only preserve the semantic
		// bits mtag exposes; compression/encryption round-trip if
		// they were already set.
		w.Write(remapFlags(flags, 3))
	case 4:
		if len(id) != 4 {
			return fmt.Errorf("id3v2: frame ID %q is not 4 chars", id)
		}
		w.WriteString(id)
		var sz [4]byte
		if err := EncodeSynchsafe(sz[:], uint32(size)); err != nil {
			return err
		}
		w.Write(sz[:])
		w.Write(remapFlags(flags, 4))
	default:
		return fmt.Errorf("id3v2: unsupported version %d", version)
	}
	return nil
}

func remapFlags(in FrameFlags, target byte) []byte {
	if in.Version == target {
		// Same-version round-trip: keep the on-disk flag bytes
		// verbatim so Compressed / Encrypted / Grouped / DLI
		// survive a re-save alongside the re-compressed body.
		return in.Raw[:]
	}
	var out [2]byte
	// Preserve the three status bits (tag/file alter preservation,
	// read-only). Drop format-specific bits (compression etc.) since
	// translating them correctly requires re-encoding the frame
	// body, which the frame itself already handles.
	if in.TagAlterPreservation() {
		switch target {
		case 3:
			out[0] |= 0x80
		case 4:
			out[0] |= 0x40
		}
	}
	if in.FileAlterPreservation() {
		switch target {
		case 3:
			out[0] |= 0x40
		case 4:
			out[0] |= 0x20
		}
	}
	if in.ReadOnly() {
		switch target {
		case 3:
			out[0] |= 0x20
		case 4:
			out[0] |= 0x10
		}
	}
	return out[:]
}

// NewTag creates an empty tag for the given major version. Pass 4
// when in doubt.
func NewTag(version byte) *Tag {
	return &Tag{Version: version, Revision: 0}
}

// frameSortPriority is the recommended serialisation order for
// well-known frames, following the advice in id3v2.4.0-structure
// §4: identifiers that matter most for recognising the file come
// first (UFID, TIT2, MCDI, TRCK, …) followed by the bulk text
// frames, then comments, URL links, user-defined fields, and
// finally large binary payloads.
var frameSortPriority = map[string]int{
	"UFID": 10,
	"TIT2": 20, "TPE1": 21, "TALB": 22, "TPE2": 23, "TPOS": 24, "TRCK": 25,
	"TYER": 26, "TDRC": 26, "TDRL": 27, "TCON": 28, "TCOM": 29, "TCOP": 30,
	"TLEN": 31, "TBPM": 32, "TENC": 33, "TPUB": 34, "TSRC": 35,
	"MCDI": 40,
	"COMM": 50, "USLT": 51,
	"WXXX": 60, "TXXX": 61,
	"POPM": 70, "PCNT": 71,
	"APIC": 80, "GEOB": 81,
	"PRIV": 90, "CHAP": 91, "CTOC": 92,
}

// Sort re-orders the frames according to [frameSortPriority],
// stable-sorting unknown frames to the end in their original
// relative order. Many readers recover faster when well-known
// frames come first; a few legacy players outright need TIT2
// before the first APIC.
func (t *Tag) Sort() {
	// Simple insertion sort keeps things stable with minimal fuss.
	n := len(t.Frames)
	moved := false
	for i := 1; i < n; i++ {
		j := i
		pi := priority(t.Frames[i].ID())
		for j > 0 && priority(t.Frames[j-1].ID()) > pi {
			t.Frames[j-1], t.Frames[j] = t.Frames[j], t.Frames[j-1]
			j--
			moved = true
		}
	}
	if moved {
		t.InvalidateIndex()
	}
}

func priority(id string) int {
	if p, ok := frameSortPriority[id]; ok {
		return p
	}
	return 1000 // unknown frames sort to the back
}

// renderYearOnly encodes a TextFrame as the target ID but with every
// value truncated to its first four ASCII-digit characters. Used
// when downgrading a v2.4 TDRC/TDOR timestamp to a v2.3 TYER/TORY
// year-only frame.
func renderYearOnly(targetID string, f Frame, version byte) ([]byte, error) {
	tf, ok := f.(*TextFrame)
	if !ok {
		// Fallback: render verbatim so we never silently drop data.
		return f.Body(version)
	}
	trimmed := &TextFrame{
		FrameID:    targetID,
		FrameFlags: tf.FrameFlags,
		Values:     make([]string, len(tf.Values)),
	}
	for i, v := range tf.Values {
		// Cut at the first non-digit or at four characters,
		// whichever comes first. An all-digit stretch shorter than
		// four characters is kept as-is.
		end := 0
		for end < len(v) && end < 4 && v[end] >= '0' && v[end] <= '9' {
			end++
		}
		trimmed.Values[i] = v[:end]
	}
	return trimmed.Body(version)
}
