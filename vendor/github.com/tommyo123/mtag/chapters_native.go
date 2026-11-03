package mtag

import (
	"encoding/binary"
	"sort"
	"strconv"
	"strings"
	"time"
)

type wavCueChapterPoint struct {
	id    uint32
	start time.Duration
}

func (f *File) vorbisCommentChapters() []Chapter {
	if f.flac == nil || f.flac.comment == nil {
		return nil
	}

	type entry struct {
		Chapter
		index int
	}

	byIndex := make(map[int]*entry)
	for _, field := range f.flac.comment.Fields {
		index, suffix, ok := parseVorbisChapterField(field.Name)
		if !ok {
			continue
		}
		ch := byIndex[index]
		if ch == nil {
			ch = &entry{Chapter: Chapter{ID: strconv.Itoa(index)}, index: index}
			byIndex[index] = ch
		}
		switch suffix {
		case "":
			if start, ok := parseVorbisChapterTimestamp(field.Value); ok {
				ch.Start = start
			}
		case "NAME":
			ch.Title = field.Value
		case "URL":
			ch.URL = field.Value
		}
	}

	if len(byIndex) == 0 {
		return nil
	}

	ordered := make([]*entry, 0, len(byIndex))
	for _, ch := range byIndex {
		ordered = append(ordered, ch)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].index < ordered[j].index
	})

	out := make([]Chapter, 0, len(ordered))
	for _, ch := range ordered {
		out = append(out, ch.Chapter)
	}
	for i := 0; i+1 < len(out); i++ {
		if out[i].End == 0 && out[i+1].Start > out[i].Start {
			out[i].End = out[i+1].Start
		}
	}
	if dur := f.AudioProperties().Duration; len(out) > 0 && dur > out[len(out)-1].Start {
		out[len(out)-1].End = dur
	}
	return out
}

func parseVorbisChapterField(name string) (index int, suffix string, ok bool) {
	name = strings.ToUpper(strings.TrimSpace(name))
	if !strings.HasPrefix(name, "CHAPTER") || len(name) <= len("CHAPTER") {
		return 0, "", false
	}
	rest := name[len("CHAPTER"):]
	digits := 0
	for digits < len(rest) && rest[digits] >= '0' && rest[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return 0, "", false
	}
	index, err := strconv.Atoi(rest[:digits])
	if err != nil {
		return 0, "", false
	}
	suffix = rest[digits:]
	switch suffix {
	case "", "NAME", "URL":
		return index, suffix, true
	default:
		return 0, "", false
	}
}

func parseVorbisChapterTimestamp(s string) (time.Duration, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if !strings.Contains(s, ":") {
		if ms, err := strconv.ParseInt(s, 10, 64); err == nil && ms >= 0 {
			return time.Duration(ms) * time.Millisecond, true
		}
		if d, err := time.ParseDuration(s); err == nil && d >= 0 {
			return d, true
		}
		return 0, false
	}

	parts := strings.Split(s, ":")
	if len(parts) != 2 && len(parts) != 3 {
		return 0, false
	}

	var hours, minutes int64
	var err error
	if len(parts) == 3 {
		hours, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil || hours < 0 {
			return 0, false
		}
		minutes, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || minutes < 0 {
			return 0, false
		}
	} else {
		minutes, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil || minutes < 0 {
			return 0, false
		}
	}

	seconds, nanos, ok := parseVorbisChapterSeconds(parts[len(parts)-1])
	if !ok {
		return 0, false
	}
	return time.Duration(hours)*time.Hour +
		time.Duration(minutes)*time.Minute +
		time.Duration(seconds)*time.Second +
		time.Duration(nanos), true
}

func parseVorbisChapterSeconds(s string) (seconds int64, nanos int64, ok bool) {
	whole := s
	fraction := ""
	if dot := strings.IndexByte(s, '.'); dot >= 0 {
		whole = s[:dot]
		fraction = s[dot+1:]
	}
	seconds, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || seconds < 0 {
		return 0, 0, false
	}
	if fraction == "" {
		return seconds, 0, true
	}
	for _, r := range fraction {
		if r < '0' || r > '9' {
			return 0, 0, false
		}
	}
	if len(fraction) > 9 {
		fraction = fraction[:9]
	}
	for len(fraction) < 9 {
		fraction += "0"
	}
	nanos, err = strconv.ParseInt(fraction, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return seconds, nanos, true
}

func (f *File) wavCueChapters() []Chapter {
	if f.Container() != ContainerWAV || f.src == nil {
		return nil
	}
	sampleRate := f.AudioProperties().SampleRate
	if sampleRate <= 0 {
		return nil
	}

	outer := readIFFOuterMagic(f.src)
	if f.container != nil {
		if info := f.container.info(); info != nil && info.outerMagic != [4]byte{} {
			outer = info.outerMagic
		}
	}

	var cues []wavCueChapterPoint
	labels := map[uint32]string{}
	for _, chunk := range listIFFChunks(f.src, f.size, binary.LittleEndian, outer) {
		switch string(chunk.ID[:]) {
		case "cue ":
			body := make([]byte, chunk.DataSize)
			if _, err := f.src.ReadAt(body, chunk.DataAt); err == nil {
				cues = parseWAVCueChunk(body, sampleRate)
			}
		case "LIST":
			if chunk.DataSize < 4 {
				continue
			}
			var kind [4]byte
			if _, err := f.src.ReadAt(kind[:], chunk.DataAt); err != nil || string(kind[:]) != "adtl" {
				continue
			}
			body := make([]byte, chunk.DataSize-4)
			if _, err := f.src.ReadAt(body, chunk.DataAt+4); err == nil {
				parseWAVAdtlLabels(body, labels)
			}
		}
	}
	if len(cues) == 0 {
		return nil
	}

	sort.SliceStable(cues, func(i, j int) bool {
		if cues[i].start == cues[j].start {
			return cues[i].id < cues[j].id
		}
		return cues[i].start < cues[j].start
	})

	out := make([]Chapter, 0, len(cues))
	for _, cue := range cues {
		out = append(out, Chapter{
			ID:    strconv.FormatUint(uint64(cue.id), 10),
			Start: cue.start,
			Title: labels[cue.id],
		})
	}
	for i := 0; i+1 < len(out); i++ {
		if out[i+1].Start > out[i].Start {
			out[i].End = out[i+1].Start
		}
	}
	if dur := f.AudioProperties().Duration; dur > 0 && dur > out[len(out)-1].Start {
		out[len(out)-1].End = dur
	}
	return out
}

func parseWAVCueChunk(body []byte, sampleRate int) []wavCueChapterPoint {
	if len(body) < 4 || sampleRate <= 0 {
		return nil
	}
	count := int(binary.LittleEndian.Uint32(body[:4]))
	out := make([]wavCueChapterPoint, 0, count)
	for cur, i := 4, 0; i < count && cur+24 <= len(body); i, cur = i+1, cur+24 {
		id := binary.LittleEndian.Uint32(body[cur : cur+4])
		sampleOffset := binary.LittleEndian.Uint32(body[cur+20 : cur+24])
		start := time.Duration(sampleOffset) * time.Second / time.Duration(sampleRate)
		out = append(out, wavCueChapterPoint{id: id, start: start})
	}
	return out
}

func parseWAVAdtlLabels(body []byte, labels map[uint32]string) {
	for cur := 0; cur+8 <= len(body); {
		id := string(body[cur : cur+4])
		size := int(binary.LittleEndian.Uint32(body[cur+4 : cur+8]))
		if size < 0 || cur+8+size > len(body) {
			break
		}
		if (id == "labl" || id == "note") && size >= 4 {
			cueID := binary.LittleEndian.Uint32(body[cur+8 : cur+12])
			value := trimRIFFText(body[cur+12 : cur+8+size])
			if value != "" {
				if _, exists := labels[cueID]; !exists || id == "labl" {
					labels[cueID] = value
				}
			}
		}
		next := cur + 8 + size
		if size%2 == 1 {
			next++
		}
		cur = next
	}
}
