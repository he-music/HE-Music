package metadata

import (
	"encoding/binary"
	"slices"
)

// DSDIFF uses 64-bit big-endian chunk sizes and even-byte padding. Keep the
// chunk walker independent of the tag writer, including all extent checks.
type dffChunk struct {
	kind              string
	start, size, next int64
}

func readDFFChunk(s payloadSource, off, end int64) (dffChunk, error) {
	var header [12]byte
	if off < 0 || end > s.size || end-off < int64(len(header)) {
		return dffChunk{}, ErrInvalidPayload
	}
	if err := s.read(off, header[:]); err != nil {
		return dffChunk{}, err
	}
	start := off + 12
	n := binary.BigEndian.Uint64(header[4:])
	if n > uint64(end-start) {
		return dffChunk{}, ErrInvalidPayload
	}
	next := start + int64(n) + int64(n&1)
	if next > end {
		return dffChunk{}, ErrInvalidPayload
	}
	return dffChunk{string(header[:4]), start, int64(n), next}, nil
}

type dffLayout struct {
	codec      string
	duration   float64
	mediaSize  int64
	mediaStart int64
	indexed    bool
	frames     uint32
}

// inspectDFF reads only headers and properties, so library scans never load DST
// frames or artwork. Full transfer/save validation additionally checks framing.
func inspectDFF(s payloadSource) (dffLayout, error) {
	var out dffLayout
	chunks, err := readDFFHeader(s)
	if err != nil {
		return out, err
	}
	sampleRate, channels, compression, err := readDFFProperties(s, chunks["PROP"])
	if err != nil {
		return out, err
	}
	media, ok := chunks[compression]
	_, raw := chunks["DSD "]
	_, dst := chunks["DST "]
	if !ok || media.size == 0 || raw == dst {
		return out, ErrInvalidPayload
	}
	index, indexed := chunks["DSTI"]
	if indexed && (compression != "DST " || index.size == 0 || index.size%12 != 0) {
		return out, ErrInvalidPayload
	}
	out.mediaStart, out.mediaSize, out.indexed = media.start, media.size, indexed
	if compression == "DSD " {
		if media.size%int64(channels) != 0 {
			return out, ErrInvalidPayload
		}
		out.codec = "dsd"
		out.duration = float64(media.size) * 8 / float64(sampleRate) / float64(channels)
		return out, nil
	}
	frames, frameRate, err := readDSTFrameInfo(s, media)
	if err != nil {
		return out, err
	}
	out.frames, out.codec = frames, "dst"
	out.duration = float64(frames) / float64(frameRate)
	return out, nil
}

func readDFFHeader(s payloadSource) (map[string]dffChunk, error) {
	var head [16]byte
	if err := s.read(0, head[:]); err != nil {
		return nil, err
	}
	if string(head[:4]) != "FRM8" || string(head[12:]) != "DSD " || binary.BigEndian.Uint64(head[4:12]) != uint64(s.size-12) {
		return nil, ErrInvalidPayload
	}
	chunks, err := readDFFChunkList(s, 16, s.size, "FVER", "PROP", "DSD ", "DST ", "DSTI", "ID3 ")
	if err != nil {
		return nil, err
	}
	version := chunks["FVER"]
	if version.size != 4 {
		return nil, ErrInvalidPayload
	}
	var data [4]byte
	if err := s.read(version.start, data[:]); err != nil {
		return nil, err
	}
	if data[0] != 1 {
		return nil, ErrUnsupportedPayload
	}
	return chunks, nil
}

// Only the requested chunk kinds are retained, bounding memory independently of
// frame/tag counts. Duplicate configuration, audio and ID3 chunks are refused.
func readDFFChunkList(s payloadSource, start, end int64, kinds ...string) (map[string]dffChunk, error) {
	chunks := make(map[string]dffChunk, len(kinds))
	for off := start; off < end; {
		chunk, err := readDFFChunk(s, off, end)
		if err != nil {
			return nil, err
		}
		if slices.Contains(kinds, chunk.kind) {
			if _, exists := chunks[chunk.kind]; exists {
				return nil, ErrInvalidPayload
			}
			chunks[chunk.kind] = chunk
		}
		off = chunk.next
	}
	return chunks, nil
}

func readDFFProperties(s payloadSource, chunk dffChunk) (uint32, uint16, string, error) {
	var data [4]byte
	if chunk.size < 4 {
		return 0, 0, "", ErrInvalidPayload
	}
	if err := s.read(chunk.start, data[:]); err != nil {
		return 0, 0, "", err
	}
	if string(data[:]) != "SND " {
		return 0, 0, "", ErrUnsupportedPayload
	}
	chunks, err := readDFFChunkList(s, chunk.start+4, chunk.start+chunk.size, "FS  ", "CHNL", "CMPR")
	if err != nil {
		return 0, 0, "", err
	}
	fs, chnl, cmpr := chunks["FS  "], chunks["CHNL"], chunks["CMPR"]
	if fs.size != 4 || chnl.size < 2 || cmpr.size < 5 {
		return 0, 0, "", ErrInvalidPayload
	}
	if err := s.read(fs.start, data[:]); err != nil {
		return 0, 0, "", err
	}
	sampleRate := binary.BigEndian.Uint32(data[:])
	if err := s.read(chnl.start, data[:2]); err != nil {
		return 0, 0, "", err
	}
	channels := binary.BigEndian.Uint16(data[:2])
	var compression [5]byte
	if err := s.read(cmpr.start, compression[:]); err != nil {
		return 0, 0, "", err
	}
	if sampleRate == 0 || channels == 0 || chnl.size != 2+int64(channels)*4 || int64(compression[4])+5 != cmpr.size {
		return 0, 0, "", ErrInvalidPayload
	}
	kind := string(compression[:4])
	if kind != "DSD " && kind != "DST " {
		return 0, 0, "", ErrUnsupportedPayload
	}
	return sampleRate, channels, kind, nil
}

func readDSTFrameInfo(s payloadSource, media dffChunk) (uint32, uint16, error) {
	frameInfo, err := readDFFChunk(s, media.start, media.start+media.size)
	if err != nil {
		return 0, 0, err
	}
	if frameInfo.kind != "FRTE" || frameInfo.size != 6 {
		return 0, 0, ErrInvalidPayload
	}
	var data [6]byte
	if err := s.read(frameInfo.start, data[:]); err != nil {
		return 0, 0, err
	}
	frames, frameRate := binary.BigEndian.Uint32(data[:4]), binary.BigEndian.Uint16(data[4:])
	if frames == 0 || frameRate == 0 {
		return 0, 0, ErrInvalidPayload
	}
	return frames, frameRate, nil
}

func hashDFFPayload(s payloadSource, h *formatPayloadHash) error {
	layout, err := inspectDFF(s)
	if err != nil {
		return err
	}
	if layout.codec == "dst" {
		if err := validateDSTFrames(s, layout); err != nil {
			return err
		}
	}
	h.Write([]byte("DSDIFF"))
	// DSTI contains absolute offsets. Refuse rewrites that move indexed audio
	// without relocating its index, even if the encoded frame bytes are equal.
	if layout.indexed {
		var position [8]byte
		binary.BigEndian.PutUint64(position[:], uint64(layout.mediaStart))
		h.Write(position[:])
	}
	for off := int64(16); off < s.size; {
		chunk, err := readDFFChunk(s, off, s.size)
		if err != nil {
			return err
		}
		// Only ID3 tags and the FRM8 size may change. Preserve native comments,
		// markers, channel configuration, seek indexes and unknown chunks too.
		if chunk.kind != "ID3 " {
			if err := hashFormatSection(s, h, chunk.kind, chunk.start, chunk.start+chunk.size); err != nil {
				return err
			}
		}
		off = chunk.next
	}
	return nil
}

func validateDSTFrames(s payloadSource, layout dffLayout) error {
	var frames uint32
	previous := ""
	for off, end := layout.mediaStart, layout.mediaStart+layout.mediaSize; off < end; {
		chunk, err := readDFFChunk(s, off, end)
		if err != nil {
			return err
		}
		switch chunk.kind {
		case "FRTE":
			if off != layout.mediaStart {
				return ErrInvalidPayload
			}
		case "DSTF":
			if chunk.size == 0 || frames >= layout.frames {
				return ErrInvalidPayload
			}
			frames++
		case "DSTC":
			if previous != "DSTF" || chunk.size != 4 {
				return ErrInvalidPayload
			}
		default:
			return ErrUnsupportedPayload
		}
		previous = chunk.kind
		off = chunk.next
	}
	if frames != layout.frames {
		return ErrInvalidPayload
	}
	return nil
}
