package flac

import (
	"encoding/binary"
	"fmt"
	"strings"
)

// CueSheet is the parsed payload of a [BlockCueSheet] metadata block.
type CueSheet struct {
	MediaCatalog  string
	LeadInSamples uint64
	IsCD          bool
	Tracks        []CueTrack
}

// CueTrack is one track entry inside a [CueSheet].
type CueTrack struct {
	OffsetSamples uint64
	Number        byte
	ISRC          string
	IsAudio       bool
	PreEmphasis   bool
	Indices       []CueIndex
}

// CueIndex is one index point inside a [CueTrack].
type CueIndex struct {
	OffsetSamples uint64
	Number        byte
}

// DecodeCueSheet parses a [BlockCueSheet] body.
func DecodeCueSheet(body []byte) (*CueSheet, error) {
	const headerSize = 128 + 8 + 1 + 258 + 1
	if len(body) < headerSize {
		return nil, fmt.Errorf("flac: short CUESHEET block")
	}
	cur := 0
	read8 := func() byte {
		v := body[cur]
		cur++
		return v
	}
	read64 := func() uint64 {
		v := binary.BigEndian.Uint64(body[cur:])
		cur += 8
		return v
	}
	readBytes := func(n int) ([]byte, error) {
		if cur+n > len(body) {
			return nil, fmt.Errorf("flac: CUESHEET field overruns block")
		}
		b := body[cur : cur+n]
		cur += n
		return b, nil
	}

	catalog, _ := readBytes(128)
	cs := &CueSheet{
		MediaCatalog:  strings.TrimRight(string(catalog), "\x00"),
		LeadInSamples: read64(),
	}
	flags := read8()
	cs.IsCD = flags&0x80 != 0
	if _, err := readBytes(258); err != nil {
		return nil, err
	}
	nTracks := int(read8())
	cs.Tracks = make([]CueTrack, 0, nTracks)
	for i := 0; i < nTracks; i++ {
		if cur+36 > len(body) {
			return nil, fmt.Errorf("flac: truncated CUESHEET track %d", i)
		}
		tr := CueTrack{
			OffsetSamples: read64(),
			Number:        read8(),
		}
		isrc, _ := readBytes(12)
		tr.ISRC = strings.TrimRight(string(isrc), "\x00")
		flags := read8()
		tr.IsAudio = flags&0x80 == 0
		tr.PreEmphasis = flags&0x40 != 0
		if _, err := readBytes(13); err != nil {
			return nil, err
		}
		nIdx := int(read8())
		tr.Indices = make([]CueIndex, 0, nIdx)
		for j := 0; j < nIdx; j++ {
			if cur+12 > len(body) {
				return nil, fmt.Errorf("flac: truncated CUESHEET track %d index %d", i, j)
			}
			idx := CueIndex{
				OffsetSamples: read64(),
				Number:        read8(),
			}
			if _, err := readBytes(3); err != nil {
				return nil, err
			}
			tr.Indices = append(tr.Indices, idx)
		}
		cs.Tracks = append(cs.Tracks, tr)
	}
	return cs, nil
}
