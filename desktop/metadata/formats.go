package metadata

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"sort"

	"github.com/tommyo123/mtag/ape"
)

type formatPayloadHash struct {
	hash.Hash
	buffer [32768]byte
}

// CompareFormatAudioPayload protects metadata saves for the additional supported
// containers. It compares encoded media and decoding configuration, without
// decoding audio or trusting the metadata writer's output. MP3/FLAC keep their
// stricter existing validators. Unsupported layouts fail closed. Memory use
// grows only with the number of MP4 mdat extents; media and tags are streamed.
// Readers must stay immutable throughout the comparison.
func CompareFormatAudioPayload(ctx context.Context, left io.ReaderAt, leftSize int64, right io.ReaderAt, rightSize int64) error {
	var sums [2][32]byte
	for i, s := range []payloadSource{{ctx, left, leftSize}, {ctx, right, rightSize}} {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s.r == nil || s.size <= 0 {
			return ErrInvalidPayload
		}
		h := &formatPayloadHash{Hash: sha256.New()}
		if err := hashFormatPayload(s, h); err != nil {
			return fmt.Errorf("payload %d: %w", i, err)
		}
		copy(sums[i][:], h.Sum(nil))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if sums[0] != sums[1] {
		return ErrAudioPayloadChanged
	}
	return nil
}

func hashFormatRange(s payloadSource, h *formatPayloadHash, start, end int64) error {
	if start < 0 || end < start || end > s.size {
		return ErrInvalidPayload
	}
	buf := h.buffer[:]
	for start < end {
		n := min(int64(len(buf)), end-start)
		if err := s.read(start, buf[:n]); err != nil {
			return err
		}
		h.Write(buf[:n])
		start += n
	}
	return nil
}

func hashFormatSection(s payloadSource, h *formatPayloadHash, kind string, start, end int64) error {
	h.Write([]byte(kind))
	var n [8]byte
	binary.BigEndian.PutUint64(n[:], uint64(end-start))
	h.Write(n[:])
	return hashFormatRange(s, h, start, end)
}

// AdditionalPayloadFormat probes only small headers through the cancellable reader.
// It selects the additional validators, not media validity: false leaves MP3/FLAC
// and unknown input to the existing strict validator. No tag body is parsed.
func AdditionalPayloadFormat(ctx context.Context, r io.ReaderAt, size int64) (bool, error) {
	kind, err := additionalPayloadKind(payloadSource{ctx, r, size})
	return kind != "", err
}

func additionalPayloadKind(s payloadSource) (string, error) {
	if err := s.ctx.Err(); err != nil {
		return "", err
	}
	if s.r == nil || s.size <= 0 {
		return "", ErrInvalidPayload
	}
	var b [12]byte
	if err := s.read(0, b[:min(s.size, int64(len(b)))]); err != nil {
		return "", err
	}
	if kind := additionalHeaderKind(b); kind != "" {
		return kind, nil
	}
	if string(b[:3]) == "ID3" {
		if s.size < 10 {
			return "", ErrInvalidPayload
		}
		if b[3] < 2 || b[3] > 4 {
			return "", ErrUnsupportedPayload
		}
		n, err := syncSafe(b[6:10])
		if err != nil {
			return "", err
		}
		off := 10 + n
		if b[3] == 4 && b[5]&0x10 != 0 {
			off += 10
		}
		if err := s.read(off, b[:2]); err != nil {
			return "", err
		}
	}
	// ADTS has layer 00; MPEG Layer III therefore stays on the old validator.
	if b[0] == 0xff && b[1]&0xf6 == 0xf0 {
		return "adts", nil
	}
	return "", nil
}

func additionalHeaderKind(b [12]byte) string {
	switch {
	case (string(b[:4]) == "RIFF" || string(b[:4]) == "RF64" || string(b[:4]) == "BW64") && string(b[8:]) == "WAVE":
		return "wave"
	case string(b[:4]) == "FORM" && (string(b[8:]) == "AIFF" || string(b[8:]) == "AIFC"):
		return "aiff"
	case string(b[4:8]) == "ftyp":
		return "mp4"
	case string(b[:4]) == "OggS":
		return "ogg"
	case string(b[:4]) == "MAC ":
		return "mac"
	case string(b[:4]) == "FRM8":
		return "dff"
	case binary.BigEndian.Uint32(b[:4]) == 0x1a45dfa3:
		return "webm"
	default:
		return ""
	}
}

func hashFormatPayload(s payloadSource, h *formatPayloadHash) error {
	kind, err := additionalPayloadKind(s)
	if err != nil {
		return err
	}
	switch kind {
	case "wave":
		return hashIFFPayload(s, h, false)
	case "aiff":
		return hashIFFPayload(s, h, true)
	case "mp4":
		return hashMP4Payload(s, h)
	case "ogg":
		return hashOggPayload(s, h)
	case "mac":
		return hashMACPayload(s, h)
	case "webm":
		return hashWebMPayload(s, h)
	case "dff":
		return hashDFFPayload(s, h)
	case "adts":
		return hashADTSPayload(s, h)
	default:
		return ErrUnsupportedPayload
	}
}

func hashIFFPayload(s payloadSource, h *formatPayloadHash, aiff bool) error {
	var head [12]byte
	if err := s.read(0, head[:]); err != nil {
		return err
	}
	layout, err := readIFFLayout(s, head, aiff)
	if err != nil {
		return err
	}
	h.Write(head[:4])
	h.Write(head[8:])
	configs, medias := 0, 0
	for off := int64(12); off < s.size; {
		var b [8]byte
		if err := s.read(off, b[:]); err != nil {
			return err
		}
		n := int64(layout.order.Uint32(b[4:]))
		if layout.extended && string(b[:4]) == "data" && n == 0xffffffff {
			n = layout.dataSize
		}
		start := off + 8
		if n > s.size-start {
			return ErrInvalidPayload
		}
		config, media, err := layout.hashChunk(s, h, string(b[:4]), start, n)
		if err != nil {
			return err
		}
		configs += config
		medias += media
		off = start + n + (n & 1)
		if off > s.size {
			return ErrInvalidPayload
		}
	}
	if configs != 1 || medias != 1 {
		return fmt.Errorf("%w: missing/duplicate audio chunks", ErrInvalidPayload)
	}
	return nil
}

// ID3 and APE boundaries come from their actual on-disk headers, never a suffix.
func formatRawBounds(s payloadSource) (int64, int64, error) {
	start, end := int64(0), s.size
	var b [10]byte
	if err := s.read(0, b[:]); err != nil {
		return 0, 0, err
	}
	if string(b[:3]) == "ID3" {
		if b[3] < 2 || b[3] > 4 {
			return 0, 0, ErrUnsupportedPayload
		}
		n, err := syncSafe(b[6:])
		if err != nil {
			return 0, 0, err
		}
		start = 10 + n
		if b[3] == 4 && b[5]&0x10 != 0 {
			start += 10
		}
	}
	if end >= 128 {
		var tag [3]byte
		if err := s.read(end-128, tag[:]); err != nil {
			return 0, 0, err
		}
		if string(tag[:]) == "TAG" {
			end -= 128
		}
	}
	at, n, err := ape.Region(s.r, end)
	if err != nil && !errors.Is(err, ape.ErrNotPresent) {
		return 0, 0, err
	}
	if n > 0 {
		end = at
	}
	if start >= end {
		return 0, 0, ErrInvalidPayload
	}
	return start, end, nil
}

func hashADTSPayload(s payloadSource, h *formatPayloadHash) error {
	start, end, err := formatRawBounds(s)
	if err != nil {
		return err
	}
	h.Write([]byte("adts"))
	frames := 0
	for off := start; off < end; {
		var b [7]byte
		if err := s.read(off, b[:]); err != nil {
			return err
		}
		if b[0] != 255 || b[1]&0xf6 != 0xf0 {
			return ErrUnsupportedPayload
		}
		if (b[2]>>2)&15 >= 13 {
			return ErrInvalidPayload
		}
		n := int64(b[3]&3)<<11 | int64(b[4])<<3 | int64(b[5]>>5)
		header := int64(7)
		if b[1]&1 == 0 {
			header = 9
		}
		if n <= header || n > end-off {
			return ErrInvalidPayload
		}
		if err := hashFormatSection(s, h, "frame", off, off+n); err != nil {
			return err
		}
		off += n
		frames++
	}
	if frames == 0 {
		return ErrInvalidPayload
	}
	return nil
}

func hashMACPayload(s payloadSource, h *formatPayloadHash) error {
	start, end, err := formatRawBounds(s)
	if err != nil {
		return err
	}
	if start != 0 || end < 32 {
		return ErrInvalidPayload
	}
	var desc [52]byte
	if err := s.read(0, desc[:6]); err != nil {
		return err
	}
	version := binary.LittleEndian.Uint16(desc[4:6])
	if version < 3800 || version > 3990 {
		return ErrUnsupportedPayload
	}
	if version >= 3980 {
		if err := s.read(0, desc[:]); err != nil {
			return err
		}
		descriptor := int64(binary.LittleEndian.Uint32(desc[8:12]))
		header := int64(binary.LittleEndian.Uint32(desc[12:16]))
		if descriptor < 52 || header < 24 || descriptor > end-header {
			return ErrInvalidPayload
		}
		var audio [24]byte
		if err := s.read(descriptor, audio[:]); err != nil {
			return err
		}
		if binary.LittleEndian.Uint32(audio[12:16]) == 0 || binary.LittleEndian.Uint16(audio[18:20]) == 0 || binary.LittleEndian.Uint32(audio[20:24]) == 0 {
			return ErrInvalidPayload
		}
		remaining := end - descriptor - header
		for _, n := range []uint64{
			uint64(binary.LittleEndian.Uint32(desc[16:20])),
			uint64(binary.LittleEndian.Uint32(desc[20:24])),
			uint64(binary.LittleEndian.Uint32(desc[28:32]))<<32 | uint64(binary.LittleEndian.Uint32(desc[24:28])),
			uint64(binary.LittleEndian.Uint32(desc[32:36])),
		} {
			if n > uint64(remaining) {
				return ErrInvalidPayload
			}
			remaining -= int64(n)
		}
		if remaining != 0 {
			return ErrInvalidPayload
		}
	}
	return hashFormatSection(s, h, "mac", start, end)
}

// Atom offsets are checked with subtraction before addition to avoid overflow.
func formatAtom(s payloadSource, off, end int64) (string, int64, int64, error) {
	var b [16]byte
	if end-off < 8 {
		return "", 0, 0, ErrInvalidPayload
	}
	if err := s.read(off, b[:8]); err != nil {
		return "", 0, 0, err
	}
	n := uint64(binary.BigEndian.Uint32(b[:4]))
	header := int64(8)
	switch n {
	case 1:
		if end-off < 16 {
			return "", 0, 0, ErrInvalidPayload
		}
		if err := s.read(off+8, b[8:]); err != nil {
			return "", 0, 0, err
		}
		n = binary.BigEndian.Uint64(b[8:])
		header = 16
	case 0:
		n = uint64(end - off)
	}
	if n < uint64(header) || n > uint64(end-off) {
		return "", 0, 0, ErrInvalidPayload
	}
	return string(b[4:8]), off + header, off + int64(n), nil
}

func hashMP4Payload(s payloadSource, h *formatPayloadHash) error {
	h.Write([]byte("mp4"))
	// Build the ordered media index once, even when moov precedes mdat.
	mediaRanges, err := formatMP4MediaRanges(s)
	if err != nil {
		return err
	}
	// mdat is preserved byte-for-byte by mtag. The sample description and
	// timing/size tables are protected too; chunk offsets may shift on save.
	media, config, chunks := 0, 0, 0
	var walk func(int64, int64, int) error
	walk = func(start, end int64, depth int) error {
		if depth > 6 {
			return ErrInvalidPayload
		}
		for off := start; off < end; {
			kind, body, next, err := formatAtom(s, off, end)
			if err != nil {
				return err
			}
			switch kind {
			case "moov", "trak", "mdia", "minf", "stbl", "edts":
				if err := walk(body, next, depth+1); err != nil {
					return err
				}
			case "mdat":
				if next == body {
					return ErrInvalidPayload
				}
				media++
				if err := hashFormatSection(s, h, kind, body, next); err != nil {
					return err
				}
			case "stsd", "stts", "ctts", "stsc", "stsz", "stz2", "stss", "mvhd", "tkhd", "mdhd", "hdlr", "elst":
				if kind == "stsd" {
					config++
				}
				if err := hashFormatSection(s, h, kind, body, next); err != nil {
					return err
				}
			case "stco", "co64":
				chunks++
				if err := hashMP4ChunkOffsets(s, h, kind, body, next, mediaRanges); err != nil {
					return err
				}
			case "moof":
				return fmt.Errorf("%w: fragmented MP4", ErrUnsupportedPayload)
			}
			off = next
		}
		return nil
	}
	if err := walk(0, s.size, 0); err != nil {
		return err
	}
	if media == 0 || config == 0 || chunks == 0 {
		return ErrInvalidPayload
	}
	return nil
}

// Ogg pages can be repaginated when comments grow. Compare complete logical
// packets (including codec setup), excluding only the codec's comment packet.
// Only a single logical stream is accepted; chained/multiplexed layouts must not
// be silently reduced to one stream by a metadata writer.
func hashOggPayload(s payloadSource, h *formatPayloadHash) error {
	h.Write([]byte("ogg"))
	var stream oggPayloadStream
	for off := int64(0); off < s.size; {
		page, err := stream.readPage(s, h, off)
		if err != nil {
			return err
		}
		lastAudioPacket, err := stream.hashPackets(s, h, &page)
		if err != nil {
			return err
		}
		if err := stream.hashGranule(h, &page, lastAudioPacket); err != nil {
			return err
		}
		off = page.end
	}
	if stream.pending || !stream.eos || stream.packets < 3 {
		return ErrInvalidPayload
	}
	return nil
}

var formatOggCRCTable = func() [256]uint32 {
	var table [256]uint32
	for i := range table {
		crc := uint32(i) << 24
		for range 8 {
			if crc&0x80000000 != 0 {
				crc = crc<<1 ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
		table[i] = crc
	}
	return table
}()

func formatOggCRC(crc uint32, b []byte) uint32 {
	for _, v := range b {
		crc = crc<<8 ^ formatOggCRCTable[byte(crc>>24)^v]
	}
	return crc
}

func formatEBMLVint(s payloadSource, off, end int64, id bool) (uint64, int64, bool, error) {
	var b [8]byte
	if off >= end {
		return 0, 0, false, ErrInvalidPayload
	}
	if err := s.read(off, b[:1]); err != nil {
		return 0, 0, false, err
	}
	width := 1
	mask := byte(128)
	for mask != 0 && b[0]&mask == 0 {
		width++
		mask >>= 1
	}
	if mask == 0 || (id && width > 4) || int64(width) > end-off {
		return 0, 0, false, ErrInvalidPayload
	}
	if err := s.read(off, b[:width]); err != nil {
		return 0, 0, false, err
	}
	v := uint64(b[0])
	if !id {
		v = uint64(b[0] &^ mask)
	}
	for _, c := range b[1:width] {
		v = v<<8 | uint64(c)
	}
	unknown := !id && v == uint64(1)<<(7*width)-1
	return v, int64(width), unknown, nil
}

func formatEBMLElement(s payloadSource, off, end int64) (uint64, int64, int64, bool, error) {
	id, n, _, err := formatEBMLVint(s, off, end, true)
	if err != nil {
		return 0, 0, 0, false, err
	}
	size, m, unknown, err := formatEBMLVint(s, off+n, end, false)
	if err != nil {
		return 0, 0, 0, false, err
	}
	start := off + n + m
	if unknown {
		return id, start, end, true, nil
	}
	if size > uint64(end-start) {
		return 0, 0, 0, false, ErrInvalidPayload
	}
	return id, start, start + int64(size), false, nil
}

func hashWebMPayload(s payloadSource, h *formatPayloadHash) error {
	h.Write([]byte("matroska"))
	tracks, clusters := 0, 0
	segment := false
	for off := int64(0); off < s.size; {
		id, start, end, unknown, err := formatEBMLElement(s, off, s.size)
		if err != nil {
			return err
		}
		switch id {
		case 0x1a45dfa3:
			if off != 0 || unknown {
				return ErrInvalidPayload
			}
		case 0x18538067:
			if segment {
				return ErrUnsupportedPayload
			}
			segment = true
			tracks, clusters, err = hashWebMSegment(s, h, start, end)
			if err != nil {
				return err
			}
		default:
			if unknown {
				return ErrInvalidPayload
			}
		}
		off = end
	}
	if !segment || tracks != 1 || clusters == 0 {
		return ErrInvalidPayload
	}
	return nil
}

func hashWebMSegment(s payloadSource, h *formatPayloadHash, start, end int64) (int, int, error) {
	tracks, clusters := 0, 0
	for pos := start; pos < end; {
		child, body, next, open, err := formatEBMLElement(s, pos, end)
		if err != nil {
			return 0, 0, err
		}
		// Unknown-sized clusters require a schema-aware EBML parser.
		if open {
			return 0, 0, ErrUnsupportedPayload
		}
		switch child {
		case 0x1654ae6b:
			tracks++
			if err := hashFormatSection(s, h, "tracks", body, next); err != nil {
				return 0, 0, err
			}
		case 0x1f43b675:
			clusters++
			if next <= body {
				return 0, 0, ErrInvalidPayload
			}
			if err := hashFormatSection(s, h, "cluster", body, next); err != nil {
				return 0, 0, err
			}
		case 0x1549a966:
			// TimecodeScale gives timestamps their meaning; other Info may be tags.
			if err := hashWebMTimecodeScale(s, h, body, next); err != nil {
				return 0, 0, err
			}
		}
		pos = next
	}
	return tracks, clusters, nil
}

func hashWebMTimecodeScale(s payloadSource, h *formatPayloadHash, body, end int64) error {
	for p := body; p < end; {
		key, value, next, open, err := formatEBMLElement(s, p, end)
		if err != nil {
			return err
		}
		if open {
			return ErrInvalidPayload
		}
		if key == 0x2ad7b1 {
			if err := hashFormatSection(s, h, "scale", value, next); err != nil {
				return err
			}
		}
		p = next
	}
	return nil
}

// Absolute MP4 chunk offsets legitimately change when moov grows. Normalize each
// to its position in the concatenation of mdat bodies, and reject pointers that
// no longer address media. The index grows with mdat count, never chunk count.
type formatMP4MediaRange struct{ start, end, base int64 }

func formatMP4MediaRanges(s payloadSource) ([]formatMP4MediaRange, error) {
	var ranges []formatMP4MediaRange
	base := int64(0)
	for off := int64(0); off < s.size; {
		kind, body, next, err := formatAtom(s, off, s.size)
		if err != nil {
			return nil, err
		}
		if kind == "mdat" {
			if body == next {
				return nil, ErrInvalidPayload
			}
			ranges = append(ranges, formatMP4MediaRange{body, next, base})
			base += next - body
		}
		off = next
	}
	return ranges, nil
}

func hashMP4ChunkOffsets(s payloadSource, h *formatPayloadHash, kind string, start, end int64, mediaRanges []formatMP4MediaRange) error {
	var b [8]byte
	if end-start < 8 {
		return ErrInvalidPayload
	}
	if err := s.read(start, b[:]); err != nil {
		return err
	}
	count := int64(binary.BigEndian.Uint32(b[4:8]))
	width := int64(4)
	if kind == "co64" {
		width = 8
	}
	if count <= 0 || count != (end-start-8)/width || (end-start-8)%width != 0 {
		return ErrInvalidPayload
	}
	h.Write([]byte("chunk-offsets"))
	h.Write(b[:])
	for p := start + 8; p < end; p += width {
		if err := s.read(p, b[:width]); err != nil {
			return err
		}
		offset := uint64(binary.BigEndian.Uint32(b[:4]))
		if width == 8 {
			offset = binary.BigEndian.Uint64(b[:])
		}
		i := sort.Search(len(mediaRanges), func(i int) bool {
			return uint64(mediaRanges[i].end) > offset
		})
		if i == len(mediaRanges) || offset < uint64(mediaRanges[i].start) {
			return fmt.Errorf("%w: MP4 chunk offset outside mdat", ErrInvalidPayload)
		}
		media := mediaRanges[i]
		binary.BigEndian.PutUint64(b[:], uint64(media.base)+offset-uint64(media.start))
		h.Write(b[:])
	}
	return nil
}
