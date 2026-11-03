package mtag

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
)

// Title returns the song title, preferring the ID3v2 tag.
func (f *File) Title() string {
	return f.getField(id3v2.FrameTitle, func(v *id3v1.Tag) string { return v.Title })
}

// SetTitle updates the song title across every tag present.
func (f *File) SetTitle(s string) {
	f.setField(id3v2.FrameTitle, s, func(v *id3v1.Tag) { v.Title = s })
}

// Artist returns the primary performer.
func (f *File) Artist() string {
	return f.getField(id3v2.FrameArtist, func(v *id3v1.Tag) string { return v.Artist })
}

// SetArtist updates the primary performer.
func (f *File) SetArtist(s string) {
	f.setField(id3v2.FrameArtist, s, func(v *id3v1.Tag) { v.Artist = s })
}

// Album returns the album title.
func (f *File) Album() string {
	return f.getField(id3v2.FrameAlbum, func(v *id3v1.Tag) string { return v.Album })
}

// SetAlbum updates the album title.
func (f *File) SetAlbum(s string) {
	f.setField(id3v2.FrameAlbum, s, func(v *id3v1.Tag) { v.Album = s })
}

// AlbumArtist returns the band / ensemble field. It also checks
// common ALBUMARTIST aliases.
func (f *File) AlbumArtist() string {
	if f.v2 != nil {
		if s := f.v2.Text(id3v2.FrameBand); s != "" {
			return s
		}
		for _, name := range fieldSpec(fieldAlbumArtist).vorbis {
			if s := f.userTextValue(name); s != "" {
				return s
			}
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		for _, name := range fieldSpec(fieldAlbumArtist).vorbis {
			if s := f.flac.comment.Get(name); s != "" {
				return s
			}
		}
	}
	if f.mp4 != nil {
		if s := f.mp4String(id3v2.FrameBand); s != "" {
			return s
		}
	}
	if f.mkv != nil {
		for _, name := range fieldSpec(fieldAlbumArtist).matroska {
			if s := f.mkv.Get(name); s != "" {
				return s
			}
		}
	}
	if f.ape != nil {
		if s := firstMappedValue(f.ape, fieldSpec(fieldAlbumArtist).ape...); s != "" {
			return s
		}
	}
	if f.asf != nil {
		if s := firstMappedValue(f.asf, fieldSpec(fieldAlbumArtist).asf...); s != "" {
			return s
		}
	}
	return ""
}

// SetAlbumArtist updates the band / ensemble tag. ID3v1 has no
// matching field, so only v2 is written.
func (f *File) SetAlbumArtist(s string) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, fieldSpec(fieldAlbumArtist).vorbis, s)
		return
	}
	if kind == ContainerMatroska {
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		setMappedPrimary(f.mkv, fieldSpec(fieldAlbumArtist).matroska, s)
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedPrimary(f.asf, fieldSpec(fieldAlbumArtist).asf, s)
		return
	}
	for _, name := range fieldSpec(fieldAlbumArtist).vorbis {
		f.removeUserText(name)
	}
	f.setField(id3v2.FrameBand, s, nil)
}

// Composer returns the composer (TCOM).
func (f *File) Composer() string { return f.getField(id3v2.FrameComposer, nil) }

// SetComposer updates the composer.
func (f *File) SetComposer(s string) { f.setField(id3v2.FrameComposer, s, nil) }

// Copyright returns the copyright notice.
func (f *File) Copyright() string { return f.getField(id3v2.FrameCopyright, nil) }

// SetCopyright updates the copyright notice.
func (f *File) SetCopyright(s string) { f.setField(id3v2.FrameCopyright, s, nil) }

// Publisher returns the publisher or label.
func (f *File) Publisher() string { return f.getField(id3v2.FramePublisher, nil) }

// SetPublisher updates the publisher or label.
func (f *File) SetPublisher(s string) { f.setField(id3v2.FramePublisher, s, nil) }

// EncodedBy returns the encoder or writing application field.
func (f *File) EncodedBy() string { return f.getField(id3v2.FrameEncodedBy, nil) }

// SetEncodedBy updates the encoder or writing application field.
func (f *File) SetEncodedBy(s string) { f.setField(id3v2.FrameEncodedBy, s, nil) }

// Year returns the recording year. For ID3v2.4 it reads the first
// four characters of TDRC. For FLAC files the Vorbis DATE / YEAR field
// is consulted.
func (f *File) Year() int {
	if f.v2 != nil {
		if s := f.yearFromV2(); s != "" {
			n, _ := strconv.Atoi(s)
			return n
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		for _, name := range fieldSpec(fieldYear).vorbis {
			if s := f.flac.comment.Get(name); s != "" {
				if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
					return n
				}
			}
		}
	}
	if f.mp4 != nil {
		if y := f.mp4Year(); y > 0 {
			return y
		}
	}
	if f.mkv != nil {
		for _, name := range fieldSpec(fieldYear).matroska {
			if s := f.mkv.Get(name); s != "" {
				if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
					return n
				}
			}
		}
	}
	if f.ape != nil {
		if s := firstMappedValue(f.ape, fieldSpec(fieldYear).ape...); s != "" {
			if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
				return n
			}
		}
	}
	if f.asf != nil {
		for _, name := range fieldSpec(fieldYear).asf {
			if s := f.asf.Get(name); s != "" {
				if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
					return n
				}
			}
		}
	}
	if f.tracker != nil {
		for _, name := range fieldSpec(fieldYear).tracker {
			if s := f.tracker.Get(name); s != "" {
				if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
					return n
				}
			}
		}
	}
	if f.riffInfo != nil {
		if s := firstMappedValue(f.riffInfo, fieldSpec(fieldYear).riff...); s != "" {
			if n, _ := strconv.Atoi(yearPrefix(s)); n > 0 {
				return n
			}
		}
	}
	if f.v1 != nil {
		return f.v1.YearInt()
	}
	return 0
}

// RecordingTime parses the full TDRC timestamp into a [time.Time],
// falling back to year-only frames when needed.
func (f *File) RecordingTime() (time.Time, bool) {
	if f.v2 != nil {
		for _, id := range []string{
			id3v2.FrameRecordingTime,
			id3v2.FrameYear,
			id3v2.FrameReleaseTime,
			id3v2.FrameOriginalTime,
			id3v2.FrameOriginalYear,
		} {
			if s := f.v2.Text(id); s != "" {
				if t, ok := parseID3Timestamp(s); ok {
					return t, true
				}
			}
		}
	}
	if f.v1 != nil {
		if y := f.v1.YearInt(); y > 0 {
			return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC), true
		}
	}
	return time.Time{}, false
}

// parseID3Timestamp accepts the ISO 8601 prefixes ID3v2.4 allows.
func parseID3Timestamp(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 4 {
		return time.Time{}, false
	}
	layouts := []string{
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05",
		"2006-01-02T15:04",
		"2006-01-02T15",
		"2006-01-02",
		"2006-01",
		"2006",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	if y, err := strconv.Atoi(s[:4]); err == nil && y > 0 {
		return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC), true
	}
	return time.Time{}, false
}

// SetYear sets the recording year.
func (f *File) SetYear(y int) {
	s := ""
	if y > 0 {
		s = fmt.Sprintf("%04d", y)
	}
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, fieldSpec(fieldYear).vorbis, s)
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		setMappedPrimary(f.ape, fieldSpec(fieldYear).ape, s)
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetFrameText("TDRC", s)
		return
	}
	if kind == ContainerMatroska {
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		setMappedPrimary(f.mkv, fieldSpec(fieldYear).matroska, s)
		return
	}
	if kind == ContainerW64 {
		f.ensureRIFFInfo()
		if key := riffInfoKeyFor(id3v2.FrameRecordingTime, kind); key != "" {
			f.riffInfo.Set(key, s)
		}
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedPrimary(f.asf, fieldSpec(fieldYear).asf, s)
		return
	}
	if f.v1 == nil && f.v2 == nil && s != "" {
		if !f.ensureV2ForExclusiveField(id3v2.FrameRecordingTime, s) {
			return
		}
	}
	if f.v2 != nil {
		switch f.v2.Version {
		case 4:
			f.v2.SetText(id3v2.FrameRecordingTime, s)
		default:
			f.v2.SetText(id3v2.FrameYear, s)
		}
	}
	if f.v1 != nil {
		f.v1.Year = s
	}
}

// Track returns the track number. The optional total is available via
// TrackTotal.
func (f *File) Track() int {
	n, _ := splitPair(f.trackString())
	return n
}

// TrackTotal returns the total number of tracks in the release.
func (f *File) TrackTotal() int {
	_, n := splitPair(f.trackString())
	if n > 0 {
		return n
	}
	// ASF stores total separately.
	if f.asf != nil {
		if s := f.asf.Get("TotalTracks"); s != "" {
			return prefixInt(s)
		}
	}
	return 0
}

// SetTrack sets the track number. total may be 0 to omit it.
// When track<=0 but total>0, the value "/total" is stored so the
// release's track count is preserved.
func (f *File) SetTrack(track, total int) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		if track <= 0 {
			f.flac.comment.Set("TRACKNUMBER", "")
		} else {
			f.flac.comment.Set("TRACKNUMBER", strconv.Itoa(track))
		}
		f.flac.comment.Set("TOTALTRACKS", "")
		if total <= 0 {
			f.flac.comment.Set("TRACKTOTAL", "")
		} else {
			f.flac.comment.Set("TRACKTOTAL", strconv.Itoa(total))
		}
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		switch {
		case track <= 0 && total <= 0:
			f.ape.Set(ape.FieldTrack, "")
		case track <= 0:
			f.ape.Set(ape.FieldTrack, fmt.Sprintf("/%d", total))
		case total > 0:
			f.ape.Set(ape.FieldTrack, fmt.Sprintf("%d/%d", track, total))
		default:
			f.ape.Set(ape.FieldTrack, strconv.Itoa(track))
		}
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetTwoPart("trkn", track, total)
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		switch {
		case track <= 0 && total <= 0:
			f.asf.Set("WM/TrackNumber", "")
		case track <= 0:
			f.asf.SetTyped("WM/TrackNumber", fmt.Sprintf("/%d", total), asfTypeUnicode)
		case total > 0:
			f.asf.SetTyped("WM/TrackNumber", fmt.Sprintf("%d/%d", track, total), asfTypeUnicode)
		default:
			f.asf.Set("WM/TrackNumber", strconv.Itoa(track))
		}
		f.asf.Set("TotalTracks", "")
		return
	}
	if kind == ContainerW64 {
		f.ensureRIFFInfo()
		key := fieldSpec(fieldTrack).riff[0]
		switch {
		case track <= 0 && total <= 0:
			f.riffInfo.Set(key, "")
		case track <= 0:
			f.riffInfo.Set(key, fmt.Sprintf("/%d", total))
		case total > 0:
			f.riffInfo.Set(key, fmt.Sprintf("%d/%d", track, total))
		default:
			f.riffInfo.Set(key, strconv.Itoa(track))
		}
		return
	}
	var s string
	switch {
	case track <= 0 && total <= 0:
		s = ""
	case track <= 0:
		s = fmt.Sprintf("/%d", total)
	case total > 0:
		s = fmt.Sprintf("%d/%d", track, total)
	default:
		s = strconv.Itoa(track)
	}
	if f.v1 == nil && f.v2 == nil && s != "" {
		if !f.ensureV2ForExclusiveField(id3v2.FrameTrack, s) {
			return
		}
	}
	if f.v2 != nil {
		f.v2.SetText(id3v2.FrameTrack, s)
	}
	if f.v1 != nil {
		switch {
		case track <= 0, track > 255:
			f.v1.Track = 0
		default:
			f.v1.Track = byte(track)
		}
	}
}

func (f *File) trackString() string {
	if f.v2 != nil {
		if s := f.v2.Text(id3v2.FrameTrack); s != "" {
			return s
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		trackFields := fieldSpec(fieldTrack).vorbis
		if len(trackFields) > 0 {
			n := f.flac.comment.Get(trackFields[0])
			t := ""
			if len(trackFields) > 1 {
				t = f.flac.comment.Get(trackFields[1])
			}
			if t == "" && len(trackFields) > 2 {
				t = f.flac.comment.Get(trackFields[2])
			}
			switch {
			case n != "" && t != "":
				return n + "/" + t
			case n != "":
				return n
			}
		}
	}
	if f.mp4 != nil {
		if a, b := f.mp4TwoPart("trkn"); a > 0 || b > 0 {
			switch {
			case a > 0 && b > 0:
				return strconv.Itoa(a) + "/" + strconv.Itoa(b)
			case a > 0:
				return strconv.Itoa(a)
			default:
				return "/" + strconv.Itoa(b)
			}
		}
	}
	if f.mkv != nil {
		for _, name := range fieldSpec(fieldTrack).matroska {
			if s := f.mkv.Get(name); s != "" {
				if strings.Contains(s, "/") {
					return s
				}
				for _, totalName := range []string{"TRACKTOTAL", "TOTALTRACKS", "TOTAL_PARTS", "TOTALPARTS"} {
					if total := f.mkv.Get(totalName); total != "" {
						return s + "/" + total
					}
				}
				return s
			}
		}
	}
	if f.ape != nil {
		if s := f.ape.Get(ape.FieldTrack); s != "" {
			return s
		}
	}
	if f.asf != nil {
		for _, name := range fieldSpec(fieldTrack).asf {
			if s := f.asf.Get(name); s != "" {
				return s
			}
		}
	}
	if f.riffInfo != nil {
		if s := firstMappedValue(f.riffInfo, fieldSpec(fieldTrack).riff...); s != "" {
			return s
		}
	}
	if f.v1 != nil && f.v1.HasTrack() {
		return strconv.Itoa(int(f.v1.Track))
	}
	return ""
}

// Disc returns the disc number.
func (f *File) Disc() int {
	if f.v2 != nil {
		if s := f.v2.Text(id3v2.FramePart); s != "" {
			n, _ := splitPair(s)
			return n
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		if s := f.flac.comment.Get("DISCNUMBER"); s != "" {
			n, _ := splitPair(s)
			return n
		}
	}
	if f.mp4 != nil {
		if a, _ := f.mp4TwoPart("disk"); a > 0 {
			return a
		}
	}
	if f.ape != nil {
		if s := f.ape.Get(ape.FieldDisc); s != "" {
			n, _ := splitPair(s)
			return n
		}
	}
	if f.asf != nil {
		if s := firstMappedValue(f.asf, fieldSpec(fieldDisc).asf...); s != "" {
			n, _ := splitPair(s)
			return n
		}
	}
	return 0
}

// DiscTotal returns the total number of discs.
func (f *File) DiscTotal() int {
	if f.v2 != nil {
		if s := f.v2.Text(id3v2.FramePart); s != "" {
			_, n := splitPair(s)
			if n > 0 {
				return n
			}
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		for _, name := range []string{"DISCTOTAL", "TOTALDISCS"} {
			if s := f.flac.comment.Get(name); s != "" {
				if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
					return n
				}
			}
		}
		if s := f.flac.comment.Get("DISCNUMBER"); s != "" {
			_, n := splitPair(s)
			if n > 0 {
				return n
			}
		}
	}
	if f.mp4 != nil {
		if _, b := f.mp4TwoPart("disk"); b > 0 {
			return b
		}
	}
	if f.ape != nil {
		if s := f.ape.Get(ape.FieldDisc); s != "" {
			_, n := splitPair(s)
			return n
		}
	}
	if f.asf != nil {
		if s := firstMappedValue(f.asf, fieldSpec(fieldDisc).asf...); s != "" {
			_, n := splitPair(s)
			if n > 0 {
				return n
			}
		}
	}
	return 0
}

// SetDisc sets the disc number. total may be 0 to omit it.
// When disc<=0 but total>0, the value "/total" is stored so the
// set's disc count is preserved.
func (f *File) SetDisc(disc, total int) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		if disc <= 0 {
			f.flac.comment.Set("DISCNUMBER", "")
		} else {
			f.flac.comment.Set("DISCNUMBER", strconv.Itoa(disc))
		}
		f.flac.comment.Set("TOTALDISCS", "")
		if total <= 0 {
			f.flac.comment.Set("DISCTOTAL", "")
		} else {
			f.flac.comment.Set("DISCTOTAL", strconv.Itoa(total))
		}
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		switch {
		case disc <= 0 && total <= 0:
			f.ape.Set(ape.FieldDisc, "")
		case disc <= 0:
			f.ape.Set(ape.FieldDisc, fmt.Sprintf("/%d", total))
		case total > 0:
			f.ape.Set(ape.FieldDisc, fmt.Sprintf("%d/%d", disc, total))
		default:
			f.ape.Set(ape.FieldDisc, strconv.Itoa(disc))
		}
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetTwoPart("disk", disc, total)
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		switch {
		case disc <= 0 && total <= 0:
			f.asf.Set("WM/PartOfSet", "")
		case disc <= 0:
			f.asf.SetTyped("WM/PartOfSet", fmt.Sprintf("/%d", total), asfTypeUnicode)
		case total > 0:
			f.asf.SetTyped("WM/PartOfSet", fmt.Sprintf("%d/%d", disc, total), asfTypeUnicode)
		default:
			f.asf.Set("WM/PartOfSet", strconv.Itoa(disc))
		}
		return
	}
	if disc <= 0 && total > 0 && !f.ensureV2ForExclusiveField("TPOS", fmt.Sprintf("/%d", total)) {
		return
	}
	if disc > 0 && !f.ensureV2ForExclusiveField("TPOS", fmt.Sprintf("%d/%d", disc, total)) {
		return
	}
	if f.v2 == nil {
		return
	}
	switch {
	case disc <= 0 && total <= 0:
		f.v2.Remove(id3v2.FramePart)
	case disc <= 0:
		f.v2.SetText(id3v2.FramePart, fmt.Sprintf("/%d", total))
	case total > 0:
		f.v2.SetText(id3v2.FramePart, fmt.Sprintf("%d/%d", disc, total))
	default:
		f.v2.SetText(id3v2.FramePart, strconv.Itoa(disc))
	}
}

// Genre returns the genre.
func (f *File) Genre() string {
	if f.v2 != nil {
		if s := f.v2.Text(id3v2.FrameGenre); s != "" {
			return id3v2NormaliseGenre(s)
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		if s := f.flac.comment.Get("GENRE"); s != "" {
			return s
		}
	}
	if f.mp4 != nil {
		if s := f.mp4Genre(); s != "" {
			return s
		}
	}
	if f.mkv != nil {
		if s := f.mkv.Get("GENRE"); s != "" {
			return s
		}
	}
	if f.ape != nil {
		if s := f.ape.Get(ape.FieldGenre); s != "" {
			return s
		}
	}
	if f.asf != nil {
		if s := f.asf.Get("WM/Genre"); s != "" {
			return s
		}
	}
	if f.v2 == nil && f.flac == nil && f.mp4 == nil && f.ape == nil {
		if s := riffInfoGet(f.riffInfo, id3v2.FrameGenre); s != "" {
			return s
		}
	}
	if f.v1 != nil {
		return id3v1.GenreName(f.v1.Genre)
	}
	return ""
}

// SetGenre sets the genre.
func (f *File) SetGenre(s string) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, fieldSpec(fieldGenre).vorbis, s)
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		setMappedPrimary(f.ape, fieldSpec(fieldGenre).ape, s)
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetFrameText(id3v2.FrameGenre, s)
		if s == "" {
			f.mp4RemoveName("gnre")
		}
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedPrimary(f.asf, fieldSpec(fieldGenre).asf, s)
		return
	}
	if kind == ContainerW64 {
		f.ensureRIFFInfo()
		if key := riffInfoKeyFor(id3v2.FrameGenre, kind); key != "" {
			f.riffInfo.Set(key, s)
		}
		return
	}
	if f.v1 == nil && f.v2 == nil && s != "" {
		if !f.ensureV2ForExclusiveField(id3v2.FrameGenre, s) {
			return
		}
	}
	if f.v2 != nil {
		f.v2.SetText(id3v2.FrameGenre, s)
	}
	if f.v1 != nil {
		f.v1.SetGenreName(s)
	}
}

// Comment returns the main user comment.
func (f *File) Comment() string {
	if f.v2 != nil {
		if c := pickBestComment(f.v2.FindAll(id3v2.FrameComment)); c != nil {
			return c.Text
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		for _, name := range fieldSpec(fieldComment).vorbis {
			if s := f.flac.comment.Get(name); s != "" {
				return s
			}
		}
	}
	if f.mp4 != nil {
		if s := f.mp4ItemString("\xa9cmt"); s != "" {
			return s
		}
	}
	if f.mkv != nil {
		for _, name := range fieldSpec(fieldComment).matroska {
			if s := f.mkv.Get(name); s != "" {
				return s
			}
		}
	}
	if f.tracker != nil {
		if s := f.tracker.Get("COMMENT"); s != "" {
			return s
		}
	}
	if f.ape != nil {
		if s := f.ape.Get(ape.FieldComment); s != "" {
			return s
		}
	}
	if f.asf != nil {
		for _, name := range fieldSpec(fieldComment).asf {
			if s := f.asf.Get(name); s != "" {
				return s
			}
		}
	}
	if f.realMedia != nil {
		if s := firstMappedValue(f.realMedia, fieldSpec(fieldComment).realMedia...); s != "" {
			return s
		}
	}
	if f.v2 == nil && f.flac == nil && f.mp4 == nil && f.ape == nil {
		if s := riffInfoGet(f.riffInfo, id3v2.FrameComment); s != "" {
			return s
		}
	}
	if f.v1 != nil {
		return f.v1.Comment
	}
	return ""
}

// pickBestComment selects the most user-visible COMM from a list.
func pickBestComment(frames []id3v2.Frame) *id3v2.CommentFrame {
	var fallback *id3v2.CommentFrame
	for _, fr := range frames {
		c, ok := fr.(*id3v2.CommentFrame)
		if !ok {
			continue
		}
		if c.Description == "" {
			if strings.EqualFold(c.Language, "eng") || c.Language == "" {
				return c
			}
			if fallback == nil {
				fallback = c
			}
		}
	}
	if fallback != nil {
		return fallback
	}
	for _, fr := range frames {
		if c, ok := fr.(*id3v2.CommentFrame); ok {
			return c
		}
	}
	return nil
}

// SetComment writes a short, empty-description, English-language
// comment.
func (f *File) SetComment(s string) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, fieldSpec(fieldComment).vorbis, s)
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		setMappedPrimary(f.ape, fieldSpec(fieldComment).ape, s)
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetFrameText(id3v2.FrameComment, s)
		return
	}
	if kind == ContainerMatroska {
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		setMappedPrimary(f.mkv, fieldSpec(fieldComment).matroska, s)
		return
	}
	if isTrackerContainer(kind) {
		if f.tracker == nil {
			f.tracker = &trackerView{format: kind}
		}
		setMappedPrimary(f.tracker, fieldSpec(fieldComment).tracker, s)
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedPrimary(f.asf, fieldSpec(fieldComment).asf, s)
		return
	}
	if kind == ContainerRealMedia {
		if f.realMedia == nil {
			f.realMedia = &realMediaView{}
		}
		setMappedPrimary(f.realMedia, fieldSpec(fieldComment).realMedia, s)
		return
	}
	if kind == ContainerW64 {
		f.ensureRIFFInfo()
		if key := riffInfoKeyFor(id3v2.FrameComment, kind); key != "" {
			f.riffInfo.Set(key, s)
		}
		return
	}
	if f.v1 == nil && f.v2 == nil && s != "" {
		if !f.ensureV2ForExclusiveField(id3v2.FrameComment, s) {
			return
		}
	}
	if f.v2 != nil {
		// An empty comment is a removal, not a write of an empty
		// COMM frame — otherwise SetComment("") on a tag that had
		// no comment would create a stub frame that round-trips
		// back as an empty string.
		if s == "" {
			f.v2.Remove(id3v2.FrameComment)
		} else {
			f.v2.Set(&id3v2.CommentFrame{
				FrameID:  id3v2.FrameComment,
				Language: "eng",
				Text:     s,
			})
		}
	}
	if f.v1 != nil {
		f.v1.Comment = s
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(id3v2.FrameComment, kind); key != "" {
			f.riffInfo.Set(key, s)
		}
	}
}

// Lyrics returns the first USLT frame text, the FLAC LYRICS field, or
// an empty string when no lyrics are present.
func (f *File) Lyrics() string {
	if f.v2 != nil {
		if c, ok := f.v2.Find(id3v2.FrameLyrics).(*id3v2.CommentFrame); ok {
			return c.Text
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		if s := firstMappedValue(f.flac.comment, fieldSpec(fieldLyrics).vorbis...); s != "" {
			return s
		}
	}
	if f.mp4 != nil {
		if s := f.mp4ItemString("\xa9lyr"); s != "" {
			return s
		}
	}
	if f.mkv != nil {
		if s := firstMappedValue(f.mkv, fieldSpec(fieldLyrics).matroska...); s != "" {
			return s
		}
	}
	if f.ape != nil {
		if s := firstMappedValue(f.ape, fieldSpec(fieldLyrics).ape...); s != "" {
			return s
		}
	}
	if f.asf != nil {
		if s := firstMappedValue(f.asf, fieldSpec(fieldLyrics).asf...); s != "" {
			return s
		}
	}
	return ""
}

// SetLyrics writes a USLT frame or the native lyrics field.
func (f *File) SetLyrics(s string) {
	kind := f.Container()
	if kind == ContainerFLAC || kind == ContainerOGG {
		if s == "" {
			if f.flac != nil && f.flac.comment != nil {
				setMappedPrimary(f.flac.comment, fieldSpec(fieldLyrics).vorbis, "")
			}
			return
		}
		f.ensureFLAC()
		setMappedPrimary(f.flac.comment, fieldSpec(fieldLyrics).vorbis, s)
		return
	}
	if isAPEContainer(kind) {
		if s == "" {
			if f.ape != nil {
				for _, name := range fieldSpec(fieldLyrics).ape {
					f.ape.Remove(name)
				}
			}
			return
		}
		f.ensureAPE()
		setMappedPrimary(f.ape, fieldSpec(fieldLyrics).ape, s)
		return
	}
	if kind == ContainerMatroska {
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		setMappedPrimary(f.mkv, fieldSpec(fieldLyrics).matroska, s)
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedPrimary(f.asf, fieldSpec(fieldLyrics).asf, s)
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetFrameText(id3v2.FrameLyrics, s)
		return
	}
	if s == "" {
		if f.v2 != nil {
			f.v2.Remove(id3v2.FrameLyrics)
		}
		return
	}
	if !f.ensureV2ForExclusiveField(id3v2.FrameLyrics, s) {
		return
	}
	f.v2.Set(&id3v2.CommentFrame{FrameID: id3v2.FrameLyrics, Language: "eng", Text: s})
}

// ITunesNormalisation is the parsed payload of iTunes' "iTunNORM"
// COMM frame.
type ITunesNormalisation struct {
	LeftGain  uint32
	RightGain uint32
	Raw       [8]uint32
}

// ITunesNormalisation extracts the iTunNORM data from the matching
// COMM frame.
func (f *File) ITunesNormalisation() (ITunesNormalisation, bool) {
	if f.v2 == nil {
		return ITunesNormalisation{}, false
	}
	for _, fr := range f.v2.FindAll(id3v2.FrameComment) {
		c, ok := fr.(*id3v2.CommentFrame)
		if !ok {
			continue
		}
		if !strings.EqualFold(c.Description, "iTunNORM") {
			continue
		}
		return parseITunNORM(c.Text)
	}
	return ITunesNormalisation{}, false
}

func parseITunNORM(s string) (ITunesNormalisation, bool) {
	parts := strings.Fields(s)
	if len(parts) < 8 {
		return ITunesNormalisation{}, false
	}
	var out ITunesNormalisation
	for i := 0; i < 8; i++ {
		v, err := strconv.ParseUint(parts[i], 16, 32)
		if err != nil {
			return ITunesNormalisation{}, false
		}
		out.Raw[i] = uint32(v)
	}
	out.LeftGain = out.Raw[0]
	out.RightGain = out.Raw[1]
	return out, true
}

// IsCompilation reports whether the iTunes compilation flag is set.
func (f *File) IsCompilation() bool {
	if f.v2 != nil && f.v2.Text("TCMP") == "1" {
		return true
	}
	if f.mp4 != nil && f.mp4IsCompilation() {
		return true
	}
	return false
}

// SetCompilation toggles the iTunes TCMP flag.
func (f *File) SetCompilation(b bool) {
	if f.Container() == ContainerMP4 {
		f.ensureMP4()
		f.mp4SetCompilation(b)
		return
	}
	if !b {
		if f.v2 != nil {
			f.v2.Remove("TCMP")
		}
		return
	}
	if !f.ensureV2ForExclusiveField("TCMP", "1") {
		return
	}
	f.v2.SetText("TCMP", "1")
}
