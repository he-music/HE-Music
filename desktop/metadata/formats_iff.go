package metadata

import (
	"encoding/binary"
	"fmt"
)

type iffPayloadLayout struct {
	order          binary.ByteOrder
	config, media  string
	aiff, extended bool
	dataSize       int64
}

func readIFFLayout(s payloadSource, head [12]byte, aiff bool) (iffPayloadLayout, error) {
	layout := iffPayloadLayout{order: binary.LittleEndian, config: "fmt ", media: "data", aiff: aiff}
	if aiff {
		layout.order, layout.config, layout.media = binary.BigEndian, "COMM", "SSND"
	}
	layout.extended = !aiff && string(head[:4]) != "RIFF"
	if layout.extended {
		size, err := readIFFExtendedSize(s)
		if err != nil {
			return layout, err
		}
		layout.dataSize = size
	}
	if !layout.extended && int64(layout.order.Uint32(head[4:8]))+8 != s.size {
		return layout, fmt.Errorf("%w: RIFF/FORM extent", ErrInvalidPayload)
	}
	return layout, nil
}

func readIFFExtendedSize(s payloadSource) (int64, error) {
	var ds [36]byte
	if err := s.read(12, ds[:]); err != nil {
		return 0, err
	}
	if string(ds[:4]) != "ds64" || binary.LittleEndian.Uint32(ds[4:8]) < 28 || binary.LittleEndian.Uint32(ds[32:36]) != 0 {
		return 0, ErrUnsupportedPayload
	}
	if binary.LittleEndian.Uint64(ds[8:16]) != uint64(s.size-8) {
		return 0, ErrInvalidPayload
	}
	value := binary.LittleEndian.Uint64(ds[16:24])
	if value > uint64(s.size) {
		return 0, ErrInvalidPayload
	}
	return int64(value), nil
}

func (l iffPayloadLayout) hashChunk(s payloadSource, h *formatPayloadHash, kind string, start, n int64) (int, int, error) {
	if kind == "fact" && !l.aiff {
		if err := hashFormatSection(s, h, kind, start, start+n); err != nil {
			return 0, 0, err
		}
	}
	if kind != l.config && kind != l.media {
		return 0, 0, nil
	}
	if !l.validAudioChunk(kind, n) {
		return 0, 0, ErrInvalidPayload
	}
	if err := hashFormatSection(s, h, kind, start, start+n); err != nil {
		return 0, 0, err
	}
	if kind == l.config {
		return 1, 0, nil
	}
	return 0, 1, nil
}

func (l iffPayloadLayout) validAudioChunk(kind string, n int64) bool {
	if kind == l.config {
		if l.aiff {
			return n >= 18
		}
		return n >= 16
	}
	if l.aiff {
		return n > 8
	}
	return n != 0
}
