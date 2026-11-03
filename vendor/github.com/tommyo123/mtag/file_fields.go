package mtag

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
)

type commonField uint8

const (
	fieldTitle commonField = iota + 1
	fieldArtist
	fieldAlbum
	fieldAlbumArtist
	fieldComposer
	fieldYear
	fieldTrack
	fieldDisc
	fieldGenre
	fieldComment
	fieldLyrics
	fieldCopyright
	fieldPublisher
	fieldEncodedBy
)

type commonFieldSpec struct {
	id3       string
	vorbis    []string
	matroska  []string
	tracker   []string
	ape       []string
	asf       []string
	realMedia []string
	caf       []string
	riff      []string
}

var commonFieldSpecs = map[commonField]commonFieldSpec{
	fieldTitle: {
		id3:       id3v2.FrameTitle,
		vorbis:    []string{"TITLE"},
		matroska:  []string{"TITLE"},
		tracker:   []string{"TITLE"},
		ape:       []string{ape.FieldTitle},
		asf:       []string{"Title"},
		realMedia: []string{"Title"},
		caf:       []string{"title"},
		riff:      []string{riffINAM, riffNAME},
	},
	fieldArtist: {
		id3:       id3v2.FrameArtist,
		vorbis:    []string{"ARTIST"},
		matroska:  []string{"ARTIST"},
		ape:       []string{ape.FieldArtist},
		asf:       []string{"Author"},
		realMedia: []string{"Author"},
		caf:       []string{"artist"},
		riff:      []string{riffIART, riffAUTH},
	},
	fieldAlbum: {
		id3:      id3v2.FrameAlbum,
		vorbis:   []string{"ALBUM"},
		matroska: []string{"ALBUM"},
		ape:      []string{ape.FieldAlbum},
		asf:      []string{"WM/AlbumTitle"},
		caf:      []string{"album"},
		riff:     []string{riffIPRD},
	},
	fieldAlbumArtist: {
		id3:      id3v2.FrameBand,
		vorbis:   []string{"ALBUMARTIST", "ALBUM ARTIST"},
		matroska: []string{"ALBUMARTIST", "ALBUM_ARTIST"},
		ape:      []string{ape.FieldAlbumArtist},
		asf:      []string{"WM/AlbumArtist"},
	},
	fieldComposer: {
		id3:      id3v2.FrameComposer,
		vorbis:   []string{"COMPOSER"},
		matroska: []string{"COMPOSER"},
		ape:      []string{ape.FieldComposer},
		asf:      []string{"WM/Composer"},
		riff:     []string{riffIMUS},
	},
	fieldYear: {
		id3:      id3v2.FrameRecordingTime,
		vorbis:   []string{"DATE", "YEAR", "ORIGINALYEAR", "ORIGINALDATE"},
		matroska: []string{"DATE_RECORDED", "DATE_RELEASED", "DATE"},
		tracker:  []string{"DATE", "YEAR"},
		ape:      []string{ape.FieldYear},
		asf:      []string{"WM/Year", "Year"},
		caf:      []string{"year"},
		riff:     []string{riffICRD},
	},
	fieldTrack: {
		id3:      id3v2.FrameTrack,
		vorbis:   []string{"TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS"},
		matroska: []string{"TRACK", "TRACKNUMBER", "PART_NUMBER", "PARTNUMBER"},
		ape:      []string{ape.FieldTrack},
		asf:      []string{"WM/TrackNumber", "TrackNumber", "WM/Track"},
		riff:     []string{riffIPRT, riffITRK},
	},
	fieldDisc: {
		id3:      id3v2.FramePart,
		vorbis:   []string{"DISCNUMBER", "DISCTOTAL", "TOTALDISCS"},
		matroska: []string{"DISCNUMBER", "DISC"},
		ape:      []string{ape.FieldDisc},
		asf:      []string{"WM/PartOfSet"},
	},
	fieldGenre: {
		id3:      id3v2.FrameGenre,
		vorbis:   []string{"GENRE"},
		matroska: []string{"GENRE"},
		ape:      []string{ape.FieldGenre},
		asf:      []string{"WM/Genre"},
		caf:      []string{"genre"},
		riff:     []string{riffIGNR},
	},
	fieldComment: {
		id3:       id3v2.FrameComment,
		vorbis:    []string{"COMMENT", "DESCRIPTION"},
		matroska:  []string{"COMMENT", "DESCRIPTION"},
		tracker:   []string{"COMMENT"},
		ape:       []string{ape.FieldComment},
		asf:       []string{"Description", "WM/Comments"},
		realMedia: []string{"Comment"},
		caf:       []string{"comment"},
		riff:      []string{riffICMT, riffANNO},
	},
	fieldLyrics: {
		id3:      id3v2.FrameLyrics,
		vorbis:   []string{"LYRICS"},
		matroska: []string{"LYRICS"},
		ape:      []string{ape.FieldLyrics},
		asf:      []string{"WM/Lyrics"},
	},
	fieldCopyright: {
		id3:      id3v2.FrameCopyright,
		vorbis:   []string{"COPYRIGHT"},
		matroska: []string{"COPYRIGHT"},
		asf:      []string{"Copyright"},
		caf:      []string{"copyright"},
		riff:     []string{riffICOP, riffCOPY},
	},
	fieldPublisher: {
		id3:      id3v2.FramePublisher,
		vorbis:   []string{"PUBLISHER"},
		matroska: []string{"PUBLISHER"},
		asf:      []string{"WM/Publisher"},
		riff:     []string{riffIPUB},
	},
	fieldEncodedBy: {
		id3:      id3v2.FrameEncodedBy,
		vorbis:   []string{"ENCODED-BY", "ENCODER"},
		matroska: []string{"ENCODED_BY", "ENCODER", "WRITING_APP"},
		tracker:  []string{"TRACKERNAME", "ENCODER"},
		asf:      []string{"WM/EncodedBy"},
		riff:     []string{riffITCH, riffISFT},
	},
}

var commonFieldByFrameID = map[string]commonField{
	id3v2.FrameTitle:         fieldTitle,
	id3v2.FrameArtist:        fieldArtist,
	id3v2.FrameAlbum:         fieldAlbum,
	id3v2.FrameBand:          fieldAlbumArtist,
	id3v2.FrameComposer:      fieldComposer,
	id3v2.FrameYear:          fieldYear,
	id3v2.FrameRecordingTime: fieldYear,
	id3v2.FrameTrack:         fieldTrack,
	id3v2.FramePart:          fieldDisc,
	id3v2.FrameGenre:         fieldGenre,
	id3v2.FrameComment:       fieldComment,
	id3v2.FrameLyrics:        fieldLyrics,
	id3v2.FrameCopyright:     fieldCopyright,
	id3v2.FramePublisher:     fieldPublisher,
	id3v2.FrameEncodedBy:     fieldEncodedBy,
}

var yearFramePriority = []string{
	id3v2.FrameRecordingTime,
	id3v2.FrameYear,
	id3v2.FrameReleaseTime,
	id3v2.FrameOriginalTime,
	id3v2.FrameOriginalYear,
}

func fieldSpecByID(frameID string) commonFieldSpec {
	if field, ok := commonFieldByFrameID[frameID]; ok {
		return commonFieldSpecs[field]
	}
	return commonFieldSpec{id3: frameID}
}

func fieldSpec(field commonField) commonFieldSpec {
	return commonFieldSpecs[field]
}

// getField reads a canonical text field across the active metadata stores.
func (f *File) getField(frameID string, v1get func(*id3v1.Tag) string) string {
	spec := fieldSpecByID(frameID)
	if f.v2 != nil {
		if s := f.v2.Text(frameID); s != "" {
			return s
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		if s := firstMappedValue(f.flac.comment, spec.vorbis...); s != "" {
			return s
		}
	}
	if f.mkv != nil {
		if s := firstMappedValue(f.mkv, spec.matroska...); s != "" {
			return s
		}
	}
	if f.tracker != nil {
		if s := firstMappedValue(f.tracker, spec.tracker...); s != "" {
			return s
		}
	}
	if f.mp4 != nil {
		if s := f.mp4String(frameID); s != "" {
			return s
		}
	}
	if f.ape != nil {
		if s := firstMappedValue(f.ape, spec.ape...); s != "" {
			return s
		}
	}
	if f.asf != nil {
		if s := firstMappedValue(f.asf, spec.asf...); s != "" {
			return s
		}
	}
	if f.realMedia != nil {
		if s := firstMappedValue(f.realMedia, spec.realMedia...); s != "" {
			return s
		}
	}
	if f.caf != nil {
		if s := firstMappedValue(f.caf, spec.caf...); s != "" {
			return s
		}
	}
	if f.v2 == nil && f.flac == nil && f.mp4 == nil && f.ape == nil && f.riffInfo != nil {
		if s := firstMappedValue(f.riffInfo, spec.riff...); s != "" {
			return s
		}
	}
	if f.v1 != nil && v1get != nil {
		return v1get(f.v1)
	}
	return ""
}

func riffInfoGet(v *riffInfoView, frameID string) string {
	if v == nil {
		return ""
	}
	return firstMappedValue(v, riffInfoKeysFor(frameID)...)
}

func riffInfoKeyFor(frameID string, kind ContainerKind) string {
	for _, key := range riffInfoKeysFor(frameID) {
		switch kind {
		case ContainerWAV, ContainerW64:
			if key != riffNAME && key != riffAUTH && key != riffANNO && key != riffCOPY {
				return key
			}
		case ContainerAIFF:
			if key == riffNAME || key == riffAUTH || key == riffANNO || key == riffCOPY {
				return key
			}
		}
	}
	return ""
}

func riffInfoKeysFor(frameID string) []string {
	return fieldSpecByID(frameID).riff
}

func apeFieldFor(frameID string) string {
	spec := fieldSpecByID(frameID)
	if len(spec.ape) == 0 {
		return ""
	}
	return spec.ape[0]
}

func vorbisFieldFor(frameID string) string {
	spec := fieldSpecByID(frameID)
	if len(spec.vorbis) == 0 {
		return ""
	}
	return spec.vorbis[0]
}

func matroskaFieldFor(frameID string) []string {
	return fieldSpecByID(frameID).matroska
}

// setField writes a canonical text field to the active metadata stores.
func (f *File) setField(frameID, value string, v1set func(*id3v1.Tag)) {
	spec := fieldSpecByID(frameID)
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, spec.vorbis, value)
		return
	}
	if kind == ContainerMatroska {
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		if !setMappedPrimary(f.mkv, spec.matroska, value) && value != "" {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: Matroska mapping not implemented", frameID, value))
		}
		return
	}
	if isTrackerContainer(kind) {
		if f.tracker == nil {
			f.tracker = &trackerView{format: kind}
		}
		if value != "" && !trackerFieldWritable(f.tracker, frameID) {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: tracker field is not writable in this file", frameID, value))
			return
		}
		if !setMappedPrimary(f.tracker, spec.tracker, value) && value != "" {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: tracker mapping not implemented", frameID, value))
		}
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		setMappedPrimary(f.ape, spec.ape, value)
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetFrameText(frameID, value)
		if value != "" && mp4ItemNameFor(frameID) == "" && !f.mp4HasMDTAKeys(mp4MDTAKeysForFrame(frameID)) {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: MP4 mapping not implemented", frameID, value))
		}
		return
	}
	if kind == ContainerCAF {
		if f.caf == nil {
			f.caf = &cafView{chunkAt: -1}
		}
		if !setMappedPrimary(f.caf, spec.caf, value) && value != "" {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: CAF mapping not implemented", frameID, value))
		}
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		if !setMappedPrimary(f.asf, spec.asf, value) && value != "" {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: ASF mapping not implemented", frameID, value))
		}
		return
	}
	if kind == ContainerRealMedia {
		if f.realMedia == nil {
			f.realMedia = &realMediaView{}
		}
		if !setMappedPrimary(f.realMedia, spec.realMedia, value) && value != "" {
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: RealMedia mapping not implemented", frameID, value))
		}
		return
	}
	if kind == ContainerW64 {
		f.ensureRIFFInfo()
		if key := riffInfoKeyFor(frameID, kind); key != "" {
			f.riffInfo.Set(key, value)
		}
		return
	}
	if f.v1 == nil && f.v2 == nil {
		f.ensureV2()
	} else if v1set == nil && value != "" && !f.ensureV2ForExclusiveField(frameID, value) {
		return
	}
	if f.v2 != nil {
		f.v2.SetText(frameID, value)
	}
	if f.v1 != nil && v1set != nil {
		v1set(f.v1)
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(frameID, kind); key != "" {
			f.riffInfo.Set(key, value)
		}
	}
	if value != "" && f.v2 == nil && (f.v1 == nil || v1set == nil) {
		f.recordErr(fmt.Errorf("mtag: %s=%q dropped: this file's tag stores cannot represent the field", frameID, value))
	}
}

func (f *File) yearFromV2() string {
	for _, id := range yearFramePriority {
		if s := f.v2.Text(id); s != "" {
			return yearPrefix(s)
		}
	}
	return ""
}

// yearPrefix extracts the numeric year from a date string. Pure digit
// sequences are returned as-is so multi-digit years round-trip; ISO
// timestamps and trailing garbage are truncated to the first 4 bytes.
func yearPrefix(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 4 && !(s[4] >= '0' && s[4] <= '9') {
		return s[:4]
	}
	return s
}

func splitPair(s string) (int, int) {
	if s == "" {
		return 0, 0
	}
	slash := strings.IndexByte(s, '/')
	if slash < 0 {
		return prefixInt(s), 0
	}
	return prefixInt(s[:slash]), prefixInt(s[slash+1:])
}

// prefixInt parses the leading decimal digits of s after trimming
// whitespace. Non-digit suffixes are ignored. It returns 0 when s
// does not start with a decimal number.
func prefixInt(s string) int {
	s = strings.TrimSpace(s)
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0
	}
	n, _ := strconv.Atoi(s[:i])
	return n
}

func id3v2NormaliseGenre(s string) string {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n >= 0 && n <= 255 {
		if name := id3v1.GenreName(byte(n)); name != "" {
			return name
		}
	}
	if len(s) < 3 || s[0] != '(' {
		return s
	}
	end := strings.IndexByte(s, ')')
	if end < 0 {
		return s
	}
	idStr := s[1:end]
	if idStr == "RX" || idStr == "CR" {
		return s
	}
	rest := s[end+1:]
	if len(rest) > 0 && rest[0] == '(' {
		if n, err := strconv.Atoi(idStr); err == nil {
			if name := id3v1.GenreName(byte(n)); name != "" {
				return name
			}
		}
		return s
	}
	if n, err := strconv.Atoi(idStr); err == nil {
		name := id3v1.GenreName(byte(n))
		if rest := s[end+1:]; rest != "" {
			return rest
		}
		if name != "" {
			return name
		}
	}
	return s
}
