package mp4

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"time"
)

// Chapter is one MP4-native chapter entry as exposed through
// QuickTime chapter tracks or the Nero-style `chpl` atom.
type Chapter struct {
	Start time.Duration
	End   time.Duration
	Title string
}

// EncodeChplBody serialises Nero-style chapter entries for a `chpl` atom body.
func EncodeChplBody(chapters []Chapter) []byte {
	if len(chapters) == 0 {
		return nil
	}
	body := []byte{0, 0, 0, 0, 0, 0, 0, 0, byte(len(chapters))}
	for _, ch := range chapters {
		var ts [4]byte
		ms := uint32(maxDuration(ch.Start, 0) / time.Millisecond)
		binary.BigEndian.PutUint32(ts[:], ms)
		body = append(body, ts[:]...)
		title := []byte(ch.Title)
		if len(title) > 255 {
			title = title[:255]
		}
		body = append(body, byte(len(title)))
		body = append(body, title...)
	}
	return body
}

func maxDuration(v, floor time.Duration) time.Duration {
	if v < floor {
		return floor
	}
	return v
}

type mp4TrackMeta struct {
	loc       atomLoc
	trackID   uint32
	handler   string
	timescale uint32
	duration  uint64
	chapRefs  []uint32
}

type stscEntry struct {
	firstChunk      uint32
	samplesPerChunk uint32
}

// ReadChapters extracts MP4-native chapters when the file carries
// either a QuickTime chapter track (`tref` / `chap` + companion
// `text` track) or a Nero-style `chpl` atom.
//
// When both layouts are present, the text-track variant wins since it
// carries the authoritative per-sample timing.
func ReadChapters(r io.ReaderAt, size int64) ([]Chapter, error) {
	if size < 8 {
		return nil, ErrNotMP4
	}
	var head [8]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	if string(head[4:8]) != "ftyp" {
		return nil, ErrNotMP4
	}
	moov, err := findChild(r, 0, size, "moov")
	if err != nil || moov.size == 0 {
		return nil, err
	}
	if chs, err := readQuickTimeTrackChapters(r, moov); err == nil && len(chs) > 0 {
		return chs, nil
	}
	return readChplChapters(r, moov)
}

func readQuickTimeTrackChapters(r io.ReaderAt, moov atomLoc) ([]Chapter, error) {
	traks := findChildren(r, moov.dataAt, moov.dataAt+moov.dataSize, "trak")
	if len(traks) == 0 {
		return nil, nil
	}
	tracks := make(map[uint32]mp4TrackMeta, len(traks))
	var chapterTrackIDs []uint32
	for _, trak := range traks {
		meta, ok := readTrackMeta(r, trak)
		if !ok || meta.trackID == 0 {
			continue
		}
		tracks[meta.trackID] = meta
		chapterTrackIDs = append(chapterTrackIDs, meta.chapRefs...)
	}
	if len(chapterTrackIDs) == 0 {
		return nil, nil
	}
	seen := map[uint32]bool{}
	for _, id := range chapterTrackIDs {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		meta, ok := tracks[id]
		if !ok {
			continue
		}
		switch meta.handler {
		case "text", "sbtl", "subt":
		default:
			continue
		}
		chs, err := readTextTrackSamples(r, meta)
		if err == nil && len(chs) > 0 {
			return chs, nil
		}
	}
	return nil, nil
}

func readTrackMeta(r io.ReaderAt, trak atomLoc) (mp4TrackMeta, bool) {
	meta := mp4TrackMeta{loc: trak}
	tkhd, _ := findChild(r, trak.dataAt, trak.dataAt+trak.dataSize, "tkhd")
	if tkhd.size == 0 {
		return meta, false
	}
	tkhdBody, err := readAtomBody(r, tkhd)
	if err != nil {
		return meta, false
	}
	if len(tkhdBody) < 20 {
		return meta, false
	}
	switch tkhdBody[0] {
	case 1:
		if len(tkhdBody) < 32 {
			return meta, false
		}
		meta.trackID = binary.BigEndian.Uint32(tkhdBody[20:24])
	default:
		meta.trackID = binary.BigEndian.Uint32(tkhdBody[12:16])
	}

	mdia, _ := findChild(r, trak.dataAt, trak.dataAt+trak.dataSize, "mdia")
	if mdia.size == 0 {
		return meta, false
	}
	hdlr, _ := findChild(r, mdia.dataAt, mdia.dataAt+mdia.dataSize, "hdlr")
	if hdlr.size != 0 {
		if body, err := readAtomBody(r, hdlr); err == nil && len(body) >= 12 {
			meta.handler = string(body[8:12])
		}
	}
	mdhd, _ := findChild(r, mdia.dataAt, mdia.dataAt+mdia.dataSize, "mdhd")
	if mdhd.size != 0 {
		if body, err := readAtomBody(r, mdhd); err == nil {
			switch {
			case len(body) >= 32 && body[0] == 1:
				meta.timescale = binary.BigEndian.Uint32(body[20:24])
				meta.duration = binary.BigEndian.Uint64(body[24:32])
			case len(body) >= 20:
				meta.timescale = binary.BigEndian.Uint32(body[12:16])
				meta.duration = uint64(binary.BigEndian.Uint32(body[16:20]))
			}
		}
	}
	tref, _ := findChild(r, trak.dataAt, trak.dataAt+trak.dataSize, "tref")
	if tref.size != 0 {
		chap, _ := findChild(r, tref.dataAt, tref.dataAt+tref.dataSize, "chap")
		if chap.size != 0 {
			if body, err := readAtomBody(r, chap); err == nil {
				for i := 0; i+4 <= len(body); i += 4 {
					meta.chapRefs = append(meta.chapRefs, binary.BigEndian.Uint32(body[i:i+4]))
				}
			}
		}
	}
	return meta, true
}

func readTextTrackSamples(r io.ReaderAt, track mp4TrackMeta) ([]Chapter, error) {
	mdia, err := findChild(r, track.loc.dataAt, track.loc.dataAt+track.loc.dataSize, "mdia")
	if err != nil || mdia.size == 0 {
		return nil, err
	}
	minf, err := findChild(r, mdia.dataAt, mdia.dataAt+mdia.dataSize, "minf")
	if err != nil || minf.size == 0 {
		return nil, err
	}
	stbl, err := findChild(r, minf.dataAt, minf.dataAt+minf.dataSize, "stbl")
	if err != nil || stbl.size == 0 {
		return nil, err
	}
	sttsLoc, _ := findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "stts")
	stscLoc, _ := findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "stsc")
	stszLoc, _ := findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "stsz")
	if stszLoc.size == 0 {
		stszLoc, _ = findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "stz2")
	}
	stcoLoc, _ := findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "stco")
	co64Loc, _ := findChild(r, stbl.dataAt, stbl.dataAt+stbl.dataSize, "co64")
	if sttsLoc.size == 0 || stscLoc.size == 0 || stszLoc.size == 0 || (stcoLoc.size == 0 && co64Loc.size == 0) {
		return nil, fmt.Errorf("mp4: incomplete chapter track sample table")
	}

	deltas, err := parseSTTS(readAtomBodyMust(r, sttsLoc))
	if err != nil || len(deltas) == 0 {
		return nil, err
	}
	chunkMap, err := parseSTSC(readAtomBodyMust(r, stscLoc))
	if err != nil || len(chunkMap) == 0 {
		return nil, err
	}
	sizes, err := parseSampleSizes(readAtomBodyMust(r, stszLoc), string(stszLoc.atomType[:]))
	if err != nil || len(sizes) == 0 {
		return nil, err
	}
	var chunkOffsets []int64
	if stcoLoc.size != 0 {
		chunkOffsets, err = parseChunkOffsets(readAtomBodyMust(r, stcoLoc), false)
	} else {
		chunkOffsets, err = parseChunkOffsets(readAtomBodyMust(r, co64Loc), true)
	}
	if err != nil || len(chunkOffsets) == 0 {
		return nil, err
	}
	offsets := sampleOffsets(chunkOffsets, chunkMap, sizes)
	n := minInt(len(deltas), len(sizes), len(offsets))
	if n == 0 {
		return nil, nil
	}
	chapters := make([]Chapter, 0, n)
	var current uint64
	for i := 0; i < n; i++ {
		sz := int(sizes[i])
		if sz <= 0 {
			current += uint64(deltas[i])
			continue
		}
		body := make([]byte, sz)
		if _, err := r.ReadAt(body, offsets[i]); err != nil {
			return chapters, err
		}
		title := decodeTextSample(body)
		start := scaleDuration(current, track.timescale)
		end := scaleDuration(current+uint64(deltas[i]), track.timescale)
		current += uint64(deltas[i])
		if title == "" {
			continue
		}
		chapters = append(chapters, Chapter{
			Start: start,
			End:   end,
			Title: title,
		})
	}
	return chapters, nil
}

func readChplChapters(r io.ReaderAt, moov atomLoc) ([]Chapter, error) {
	udta, err := findChild(r, moov.dataAt, moov.dataAt+moov.dataSize, "udta")
	if err != nil || udta.size == 0 {
		return nil, err
	}
	chpl, err := findChild(r, udta.dataAt, udta.dataAt+udta.dataSize, "chpl")
	if err != nil || chpl.size == 0 {
		return nil, err
	}
	body, err := readAtomBody(r, chpl)
	if err != nil || len(body) < 9 {
		return nil, err
	}
	version := body[0]
	count := int(body[8])
	cur := 9
	chapters := make([]Chapter, 0, count)
	scale := uint32(1000)
	step := 4
	if version == 1 {
		scale = 10000000
		step = 8
	}
	for i := 0; i < count && cur < len(body); i++ {
		if cur+step > len(body) {
			break
		}
		var startTicks uint64
		if step == 8 {
			startTicks = binary.BigEndian.Uint64(body[cur : cur+8])
		} else {
			startTicks = uint64(binary.BigEndian.Uint32(body[cur : cur+4]))
		}
		cur += step
		if cur >= len(body) {
			break
		}
		titleLen := int(body[cur])
		cur++
		if titleLen < 0 || cur+titleLen > len(body) {
			break
		}
		title := strings.TrimRight(string(body[cur:cur+titleLen]), "\x00")
		cur += titleLen
		chapters = append(chapters, Chapter{
			Start: scaleDuration(startTicks, scale),
			Title: title,
		})
	}
	if len(chapters) == 0 {
		return nil, nil
	}
	movieDur := readMovieDuration(r, moov)
	for i := range chapters {
		switch {
		case i+1 < len(chapters):
			chapters[i].End = chapters[i+1].Start
		case movieDur > chapters[i].Start:
			chapters[i].End = movieDur
		default:
			chapters[i].End = chapters[i].Start
		}
	}
	return chapters, nil
}

func findChildren(r io.ReaderAt, from, to int64, name string) []atomLoc {
	var out []atomLoc
	for cursor := from; cursor+8 <= to; {
		loc, err := readAtomHeader(r, cursor, to)
		if err != nil || loc.size <= 0 {
			break
		}
		if string(loc.atomType[:]) == name {
			out = append(out, loc)
		}
		cursor += loc.size
	}
	return out
}

func readAtomBody(r io.ReaderAt, loc atomLoc) ([]byte, error) {
	body := make([]byte, loc.dataSize)
	if len(body) == 0 {
		return body, nil
	}
	_, err := r.ReadAt(body, loc.dataAt)
	return body, err
}

func readAtomBodyMust(r io.ReaderAt, loc atomLoc) []byte {
	body, err := readAtomBody(r, loc)
	if err != nil {
		return nil
	}
	return body
}

func parseSTTS(body []byte) ([]uint32, error) {
	if len(body) < 8 {
		return nil, fmt.Errorf("mp4: short stts")
	}
	count := int(binary.BigEndian.Uint32(body[4:8]))
	cur := 8
	var out []uint32
	for i := 0; i < count && cur+8 <= len(body); i++ {
		n := int(binary.BigEndian.Uint32(body[cur : cur+4]))
		delta := binary.BigEndian.Uint32(body[cur+4 : cur+8])
		for j := 0; j < n; j++ {
			out = append(out, delta)
		}
		cur += 8
	}
	return out, nil
}

func parseSTSC(body []byte) ([]stscEntry, error) {
	if len(body) < 8 {
		return nil, fmt.Errorf("mp4: short stsc")
	}
	count := int(binary.BigEndian.Uint32(body[4:8]))
	cur := 8
	out := make([]stscEntry, 0, count)
	for i := 0; i < count && cur+12 <= len(body); i++ {
		out = append(out, stscEntry{
			firstChunk:      binary.BigEndian.Uint32(body[cur : cur+4]),
			samplesPerChunk: binary.BigEndian.Uint32(body[cur+4 : cur+8]),
		})
		cur += 12
	}
	return out, nil
}

func parseSampleSizes(body []byte, atomType string) ([]uint32, error) {
	if len(body) < 12 {
		return nil, fmt.Errorf("mp4: short %s", atomType)
	}
	if atomType == "stz2" {
		return nil, fmt.Errorf("mp4: stz2 chapter samples not supported")
	}
	sampleSize := binary.BigEndian.Uint32(body[4:8])
	count := int(binary.BigEndian.Uint32(body[8:12]))
	if sampleSize != 0 {
		out := make([]uint32, count)
		for i := range out {
			out[i] = sampleSize
		}
		return out, nil
	}
	cur := 12
	out := make([]uint32, 0, count)
	for i := 0; i < count && cur+4 <= len(body); i++ {
		out = append(out, binary.BigEndian.Uint32(body[cur:cur+4]))
		cur += 4
	}
	return out, nil
}

func parseChunkOffsets(body []byte, co64 bool) ([]int64, error) {
	if len(body) < 8 {
		return nil, fmt.Errorf("mp4: short chunk offset atom")
	}
	count := int(binary.BigEndian.Uint32(body[4:8]))
	cur := 8
	out := make([]int64, 0, count)
	width := 4
	if co64 {
		width = 8
	}
	for i := 0; i < count && cur+width <= len(body); i++ {
		if co64 {
			out = append(out, int64(binary.BigEndian.Uint64(body[cur:cur+8])))
		} else {
			out = append(out, int64(binary.BigEndian.Uint32(body[cur:cur+4])))
		}
		cur += width
	}
	return out, nil
}

func sampleOffsets(chunkOffsets []int64, stsc []stscEntry, sizes []uint32) []int64 {
	var out []int64
	sample := 0
	for i, entry := range stsc {
		if entry.firstChunk == 0 || entry.samplesPerChunk == 0 {
			continue
		}
		chunkStart := int(entry.firstChunk) - 1
		chunkEnd := len(chunkOffsets)
		if i+1 < len(stsc) && stsc[i+1].firstChunk > 0 {
			chunkEnd = int(stsc[i+1].firstChunk) - 1
		}
		for chunk := chunkStart; chunk < chunkEnd && chunk < len(chunkOffsets); chunk++ {
			off := chunkOffsets[chunk]
			for j := 0; j < int(entry.samplesPerChunk) && sample < len(sizes); j++ {
				out = append(out, off)
				off += int64(sizes[sample])
				sample++
			}
		}
	}
	return out
}

func decodeTextSample(data []byte) string {
	if len(data) >= 2 {
		n := int(binary.BigEndian.Uint16(data[:2]))
		if n >= 0 && 2+n <= len(data) {
			return strings.TrimRight(string(data[2:2+n]), "\x00")
		}
	}
	if len(data) >= 1 {
		n := int(data[0])
		if n >= 0 && 1+n <= len(data) {
			return strings.TrimRight(string(data[1:1+n]), "\x00")
		}
	}
	return ""
}

func readMovieDuration(r io.ReaderAt, moov atomLoc) time.Duration {
	mvhd, _ := findChild(r, moov.dataAt, moov.dataAt+moov.dataSize, "mvhd")
	if mvhd.size == 0 {
		return 0
	}
	body, err := readAtomBody(r, mvhd)
	if err != nil {
		return 0
	}
	switch {
	case len(body) >= 32 && body[0] == 1:
		return scaleDuration(binary.BigEndian.Uint64(body[20:28]), binary.BigEndian.Uint32(body[16:20]))
	case len(body) >= 20:
		return scaleDuration(uint64(binary.BigEndian.Uint32(body[16:20])), binary.BigEndian.Uint32(body[12:16]))
	default:
		return 0
	}
}

func scaleDuration(value uint64, timescale uint32) time.Duration {
	if timescale == 0 || value == 0 {
		return 0
	}
	return time.Duration((uint64(time.Second) * value) / uint64(timescale))
}

func minInt(v int, more ...int) int {
	for _, x := range more {
		if x < v {
			v = x
		}
	}
	return v
}
