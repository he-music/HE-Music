package mtag

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

// ReplayGain is a normalised view of a ReplayGain measurement.
type ReplayGain struct {
	Gain float64
	Peak float64
}

// ReplayGainTrack returns the per-track ReplayGain.
func (f *File) ReplayGainTrack() (ReplayGain, bool) {
	return f.replayGain("TRACK")
}

// ReplayGainAlbum returns the album-level ReplayGain.
func (f *File) ReplayGainAlbum() (ReplayGain, bool) {
	return f.replayGain("ALBUM")
}

// SetReplayGainTrack writes the per-track ReplayGain frames.
func (f *File) SetReplayGainTrack(rg ReplayGain) {
	f.setReplayGain("TRACK", rg)
}

// SetReplayGainAlbum is the album-level twin of [SetReplayGainTrack].
func (f *File) SetReplayGainAlbum(rg ReplayGain) {
	f.setReplayGain("ALBUM", rg)
}

func (f *File) replayGain(scope string) (ReplayGain, bool) {
	rg := ReplayGain{Gain: math.NaN(), Peak: math.NaN()}
	found := false
	if f.v2 != nil {
		gainKey := strings.ToLower("replaygain_" + scope + "_gain")
		peakKey := strings.ToLower("replaygain_" + scope + "_peak")
		for _, fr := range f.v2.FindAll(id3v2.FrameUserText) {
			t, ok := fr.(*id3v2.UserTextFrame)
			if !ok || len(t.Values) == 0 {
				continue
			}
			desc := strings.ToLower(t.Description)
			switch desc {
			case gainKey:
				if g, ok := parseReplayGainGain(t.Values[0]); ok {
					rg.Gain = g
					found = true
				}
			case peakKey:
				if p, err := strconv.ParseFloat(strings.TrimSpace(t.Values[0]), 64); err == nil {
					rg.Peak = p
					found = true
				}
			}
		}
		if (math.IsNaN(rg.Gain) || math.IsNaN(rg.Peak)) && f.v2.Version >= 4 {
			if alt, ok := f.replayGainFromRVA2(scope); ok {
				if math.IsNaN(rg.Gain) && !math.IsNaN(alt.Gain) {
					rg.Gain = alt.Gain
					found = true
				}
				if math.IsNaN(rg.Peak) && !math.IsNaN(alt.Peak) {
					rg.Peak = alt.Peak
					found = true
				}
			}
		}
	}
	if math.IsNaN(rg.Gain) || math.IsNaN(rg.Peak) {
		if alt, ok := f.replayGainFromNative(scope); ok {
			if math.IsNaN(rg.Gain) && !math.IsNaN(alt.Gain) {
				rg.Gain = alt.Gain
				found = true
			}
			if math.IsNaN(rg.Peak) && !math.IsNaN(alt.Peak) {
				rg.Peak = alt.Peak
				found = true
			}
		}
	}
	if math.IsNaN(rg.Gain) || math.IsNaN(rg.Peak) {
		if alt, ok := f.replayGainFromMPEGLame(scope); ok {
			if math.IsNaN(rg.Gain) && !math.IsNaN(alt.Gain) {
				rg.Gain = alt.Gain
				found = true
			}
			if math.IsNaN(rg.Peak) && !math.IsNaN(alt.Peak) {
				rg.Peak = alt.Peak
				found = true
			}
		}
	}
	return rg, found
}

func (f *File) setReplayGain(scope string, rg ReplayGain) {
	if f.setReplayGainNative(scope, rg) {
		f.stageMPEGLameReplayGain(scope, rg)
		return
	}
	gainKey := "REPLAYGAIN_" + scope + "_GAIN"
	peakKey := "REPLAYGAIN_" + scope + "_PEAK"
	if math.IsNaN(rg.Gain) && math.IsNaN(rg.Peak) {
		f.removeUserText(gainKey)
		f.removeUserText(peakKey)
		f.removeRVA2(scope)
		f.stageMPEGLameReplayGain(scope, rg)
		return
	}
	fieldName, fieldValue := "TXXX:"+gainKey, "replaygain"
	if !math.IsNaN(rg.Peak) && math.IsNaN(rg.Gain) {
		fieldName, fieldValue = "TXXX:"+peakKey, fmt.Sprintf("%.6f", rg.Peak)
	}
	if !f.ensureV2ForExclusiveField(fieldName, fieldValue) {
		return
	}
	if math.IsNaN(rg.Gain) {
		f.removeUserText(gainKey)
	} else {
		f.setUserText(gainKey, fmt.Sprintf("%+.2f dB", rg.Gain))
	}
	if math.IsNaN(rg.Peak) {
		f.removeUserText(peakKey)
	} else {
		f.setUserText(peakKey, fmt.Sprintf("%.6f", rg.Peak))
	}
	if f.v2 != nil && f.v2.Version >= 4 {
		if math.IsNaN(rg.Gain) {
			f.removeRVA2(scope)
		} else {
			f.setRVA2(scope, rg)
		}
	}
	f.stageMPEGLameReplayGain(scope, rg)
}

// parseReplayGainGain accepts either "-6.54 dB" or plain "-6.54".
func parseReplayGainGain(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(strings.TrimSuffix(s, "dB"), "DB")
	s = strings.TrimSpace(s)
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v, true
	}
	return 0, false
}

func (f *File) replayGainFromRVA2(scope string) (ReplayGain, bool) {
	if f.v2 == nil {
		return ReplayGain{Gain: math.NaN(), Peak: math.NaN()}, false
	}
	rg := ReplayGain{Gain: math.NaN(), Peak: math.NaN()}
	found := false
	for _, fr := range f.v2.FindAll(id3v2.FrameRVA2) {
		rva, ok := fr.(*id3v2.RVA2Frame)
		if !ok || !rva2ScopeMatches(scope, rva.Identification) {
			continue
		}
		ch, ok := rva2MasterChannel(rva)
		if !ok {
			continue
		}
		rg.Gain = ch.AdjustmentDB()
		found = true
		if peak, ok := ch.PeakRatio(); ok {
			rg.Peak = peak
		}
		break
	}
	return rg, found
}

func (f *File) removeRVA2(scope string) {
	if f.v2 == nil {
		return
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		rva, ok := fr.(*id3v2.RVA2Frame)
		if ok && rva2ScopeMatches(scope, rva.Identification) {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
}

func (f *File) setRVA2(scope string, rg ReplayGain) {
	if f.v2 == nil || f.v2.Version < 4 {
		return
	}
	frame, idx := f.findRVA2(scope)
	if frame == nil {
		frame = &id3v2.RVA2Frame{
			Identification: defaultRVA2Identification(scope),
		}
	} else {
		copyFrame := *frame
		copyFrame.Channels = append([]id3v2.RVA2Adjustment(nil), frame.Channels...)
		frame = &copyFrame
	}
	chIdx := -1
	for i, ch := range frame.Channels {
		if ch.Channel == id3v2.RVA2MasterVol || (len(frame.Channels) == 1 && ch.Channel == id3v2.RVA2Other) {
			chIdx = i
			break
		}
	}
	if chIdx < 0 {
		frame.Channels = append(frame.Channels, id3v2.RVA2Adjustment{Channel: id3v2.RVA2MasterVol})
		chIdx = len(frame.Channels) - 1
	}
	ch := frame.Channels[chIdx]
	if !math.IsNaN(rg.Gain) {
		ch.Adjustment = f.rva2AdjustmentFromGain(scope, rg.Gain)
	}
	if !math.IsNaN(rg.Peak) {
		ch.PeakBits, ch.Peak = f.rva2PeakBytes(scope, rg.Peak)
	} else {
		ch.PeakBits, ch.Peak = 0, nil
	}
	frame.Channels[chIdx] = ch
	if idx >= 0 {
		f.v2.Frames[idx] = frame
	} else {
		f.v2.Frames = append(f.v2.Frames, frame)
	}
}

func (f *File) findRVA2(scope string) (*id3v2.RVA2Frame, int) {
	if f.v2 == nil {
		return nil, -1
	}
	for i, fr := range f.v2.Frames {
		rva, ok := fr.(*id3v2.RVA2Frame)
		if ok && rva2ScopeMatches(scope, rva.Identification) {
			return rva, i
		}
	}
	return nil, -1
}

func rva2ScopeMatches(scope, identification string) bool {
	id := strings.ToLower(strings.TrimSpace(identification))
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope == "track" {
		return id == "" || (strings.Contains(id, "track") && !strings.Contains(id, "album"))
	}
	return strings.Contains(id, scope)
}

func defaultRVA2Identification(scope string) string {
	return "replaygain_" + strings.ToLower(scope)
}

func rva2MasterChannel(frame *id3v2.RVA2Frame) (id3v2.RVA2Adjustment, bool) {
	for _, ch := range frame.Channels {
		if ch.Channel == id3v2.RVA2MasterVol {
			return ch, true
		}
	}
	if len(frame.Channels) == 1 {
		return frame.Channels[0], true
	}
	return id3v2.RVA2Adjustment{}, false
}

func (f *File) rva2AdjustmentFromGain(scope string, gain float64) int16 {
	raw := math.Round(gain * 512.0)
	if raw > math.MaxInt16 {
		f.recordErr(fmt.Errorf("mtag: replaygain %s gain %.2f dB exceeds RVA2 range; clamped", strings.ToLower(scope), gain))
		raw = math.MaxInt16
	}
	if raw < math.MinInt16 {
		f.recordErr(fmt.Errorf("mtag: replaygain %s gain %.2f dB exceeds RVA2 range; clamped", strings.ToLower(scope), gain))
		raw = math.MinInt16
	}
	return int16(raw)
}

func (f *File) rva2PeakBytes(scope string, peak float64) (byte, []byte) {
	if peak < 0 {
		peak = 0
	}
	if peak > 1 {
		f.recordErr(fmt.Errorf("mtag: replaygain %s peak %.6f exceeds RVA2's normalised range; clamped to 1.0", strings.ToLower(scope), peak))
		peak = 1
	}
	const bits = 32
	v := uint32(math.Round(peak * float64(^uint32(0))))
	return bits, []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
}

// removeUserText drops every TXXX frame whose description equals desc.
func (f *File) removeUserText(desc string) {
	if f.v2 == nil {
		return
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		if u, ok := fr.(*id3v2.UserTextFrame); ok && strings.EqualFold(u.Description, desc) {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
}

func (f *File) userTextValue(desc string) string {
	if f.v2 == nil {
		return ""
	}
	for _, fr := range f.v2.FindAll(id3v2.FrameUserText) {
		u, ok := fr.(*id3v2.UserTextFrame)
		if !ok || len(u.Values) == 0 {
			continue
		}
		if strings.EqualFold(u.Description, desc) {
			return u.Values[0]
		}
	}
	return ""
}

// setUserText writes a single-value TXXX frame.
func (f *File) setUserText(desc, value string) {
	if value != "" && !f.ensureV2ForExclusiveField("TXXX:"+desc, value) {
		return
	}
	if f.v2 == nil {
		return
	}
	f.removeUserText(desc)
	f.v2.Frames = append(f.v2.Frames, &id3v2.UserTextFrame{
		Description: desc,
		Values:      []string{value},
	})
}

// Credit pairs a role string with the person or entity filling it.
type Credit struct {
	Role string
	Name string
}

// MusicianCredits decodes the TMCL frame.
func (f *File) MusicianCredits() []Credit {
	return f.creditPairs("TMCL")
}

// InvolvedPeople decodes the TIPL or IPLS frame.
func (f *File) InvolvedPeople() []Credit {
	if c := f.creditPairs("TIPL"); len(c) > 0 {
		return c
	}
	return f.creditPairs("IPLS")
}

func (f *File) creditPairs(id string) []Credit {
	if f.v2 == nil {
		return nil
	}
	tf, ok := f.v2.Find(id).(*id3v2.TextFrame)
	if !ok {
		return nil
	}
	out := make([]Credit, 0, len(tf.Values)/2)
	for i := 0; i+1 < len(tf.Values); i += 2 {
		out = append(out, Credit{Role: tf.Values[i], Name: tf.Values[i+1]})
	}
	return out
}

// Chapter is a flattened view of a chapter entry.
type Chapter struct {
	ID        string
	Start     time.Duration
	End       time.Duration
	Title     string
	Subtitle  string
	URL       string
	Image     []byte
	ImageMIME string
}

// Chapters returns every chapter in declaration order.
func (f *File) Chapters() []Chapter {
	if f.chaptersDirty {
		return f.chapterSnapshot()
	}
	var out []Chapter
	if f.v2 != nil {
		for _, fr := range f.v2.FindAll(id3v2.FrameChapter) {
			c, ok := fr.(*id3v2.ChapterFrame)
			if !ok {
				continue
			}
			ch := Chapter{
				ID:    c.ElementID,
				Start: time.Duration(c.StartTimeMs) * time.Millisecond,
				End:   time.Duration(c.EndTimeMs) * time.Millisecond,
			}
			for _, sub := range c.SubFrames {
				switch s := sub.(type) {
				case *id3v2.TextFrame:
					switch s.FrameID {
					case id3v2.FrameTitle:
						if len(s.Values) > 0 {
							ch.Title = s.Values[0]
						}
					case id3v2.FrameSubtitle:
						if len(s.Values) > 0 {
							ch.Subtitle = s.Values[0]
						}
					}
				case *id3v2.UserURLFrame:
					if ch.URL == "" {
						ch.URL = s.URL
					}
				case *id3v2.URLFrame:
					if ch.URL == "" {
						ch.URL = s.URL
					}
				case *id3v2.PictureFrame:
					if ch.Image == nil {
						ch.Image = append([]byte(nil), s.Data...)
						ch.ImageMIME = s.MIME
					}
				}
			}
			out = append(out, ch)
		}
	}
	if chapters := f.vorbisCommentChapters(); len(chapters) > 0 {
		out = append(out, chapters...)
	}
	if chapters := f.wavCueChapters(); len(chapters) > 0 {
		out = append(out, chapters...)
	}
	if f.Container() == ContainerMP4 {
		if chapters, err := mp4.ReadChapters(f.src, f.size); err == nil {
			for i, ch := range chapters {
				out = append(out, Chapter{
					ID:    strconv.Itoa(i + 1),
					Start: ch.Start,
					End:   ch.End,
					Title: ch.Title,
				})
			}
		}
	}
	if f.mkv != nil && len(f.mkv.Chapters) > 0 {
		for _, ch := range f.mkv.Chapters {
			out = append(out, Chapter{
				ID:        ch.ID,
				Start:     ch.Start,
				End:       ch.End,
				Title:     ch.Title,
				Subtitle:  ch.Subtitle,
				URL:       ch.URL,
				Image:     append([]byte(nil), ch.Image...),
				ImageMIME: ch.ImageMIME,
			})
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// Attachment is a container-native attached file.
type Attachment struct {
	Name        string
	Description string
	MIME        string
	Data        []byte
}

// AttachmentSummary describes one attached file without copying the
// attachment payload.
type AttachmentSummary struct {
	Name        string
	Description string
	MIME        string
	Size        int
}

// Attachments returns the container's attached files.
func (f *File) Attachments() []Attachment {
	if f.mkv == nil || len(f.mkv.Attachments) == 0 {
		return nil
	}
	out := make([]Attachment, 0, len(f.mkv.Attachments))
	for _, att := range f.mkv.Attachments {
		out = append(out, Attachment{
			Name:        att.Name,
			Description: att.Description,
			MIME:        att.MIME,
			Data:        append([]byte(nil), att.Data...),
		})
	}
	return out
}

// AttachmentSummaries returns the container's attached files without
// copying attachment payloads.
func (f *File) AttachmentSummaries() []AttachmentSummary {
	if f.mkv == nil || len(f.mkv.Attachments) == 0 {
		return nil
	}
	out := make([]AttachmentSummary, 0, len(f.mkv.Attachments))
	for _, att := range f.mkv.Attachments {
		out = append(out, AttachmentSummary{
			Name:        att.Name,
			Description: att.Description,
			MIME:        att.MIME,
			Size:        len(att.Data),
		})
	}
	return out
}

// PlayCount returns the value of the PCNT frame, or 0 when no counter
// is set.
func (f *File) PlayCount() uint64 {
	if f.v2 == nil {
		return 0
	}
	var n uint64
	if pc, ok := f.v2.Find(id3v2.FramePlayCount).(*id3v2.PlayCountFrame); ok {
		n = pc.Count
	}
	if pop, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok {
		if pop.Count > n {
			n = pop.Count
		}
	}
	return n
}

// SetPlayCount writes the play counter to a PCNT frame.
func (f *File) SetPlayCount(n uint64) {
	if n == 0 {
		if f.v2 != nil {
			f.v2.Remove(id3v2.FramePlayCount)
			if pop, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok && pop != nil {
				copyPop := *pop
				copyPop.Count = 0
				f.v2.Set(&copyPop)
			}
		}
		return
	}
	if !f.ensureV2ForExclusiveField(id3v2.FramePlayCount, strconv.FormatUint(n, 10)) {
		return
	}
	f.v2.Set(&id3v2.PlayCountFrame{Count: n})
	if pop, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok && pop != nil {
		copyPop := *pop
		copyPop.Count = n
		f.v2.Set(&copyPop)
	}
}

// Rating returns the popularimeter rating in the conventional 0-255
// range.
func (f *File) Rating() byte {
	if f.v2 == nil {
		return 0
	}
	if pop, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok {
		return pop.Rating
	}
	return 0
}

// RatingEmail returns the rater identifier stored alongside [File.Rating],
// or "" when no popularimeter frame is present.
func (f *File) RatingEmail() string {
	if f.v2 == nil {
		return ""
	}
	if pop, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok {
		return pop.Email
	}
	return ""
}

// Podcast reports whether the file carries the iTunes PCST flag.
func (f *File) Podcast() bool {
	return f.v2 != nil && f.v2.Find("PCST") != nil
}

// SetPodcast toggles the iTunes PCST flag.
func (f *File) SetPodcast(on bool) {
	if !on {
		if f.v2 != nil {
			f.v2.Remove("PCST")
		}
		return
	}
	if !f.ensureV2ForExclusiveField("PCST", "1") || f.v2 == nil {
		return
	}
	f.v2.Set(&id3v2.RawFrame{FrameID: "PCST"})
}

// PodcastCategory returns the iTunes TCAT value.
func (f *File) PodcastCategory() string {
	if f.v2 == nil {
		return ""
	}
	return f.v2.Text("TCAT")
}

// SetPodcastCategory writes the iTunes TCAT value.
func (f *File) SetPodcastCategory(s string) {
	f.setPodcastText("TCAT", s)
}

// PodcastDescription returns the iTunes TDES value.
func (f *File) PodcastDescription() string {
	if f.v2 == nil {
		return ""
	}
	return f.v2.Text("TDES")
}

// SetPodcastDescription writes the iTunes TDES value.
func (f *File) SetPodcastDescription(s string) {
	f.setPodcastText("TDES", s)
}

// PodcastIdentifier returns the iTunes TGID value.
func (f *File) PodcastIdentifier() string {
	if f.v2 == nil {
		return ""
	}
	return f.v2.Text("TGID")
}

// SetPodcastIdentifier writes the iTunes TGID value.
func (f *File) SetPodcastIdentifier(s string) {
	f.setPodcastText("TGID", s)
}

// PodcastFeedURL returns the iTunes WFED URL.
func (f *File) PodcastFeedURL() string {
	if f.v2 == nil {
		return ""
	}
	if fr, ok := f.v2.Find("WFED").(*id3v2.URLFrame); ok {
		return fr.URL
	}
	return ""
}

// SetPodcastFeedURL writes the iTunes WFED URL.
func (f *File) SetPodcastFeedURL(s string) {
	if s == "" {
		if f.v2 != nil {
			f.v2.Remove("WFED")
		}
		return
	}
	if !f.ensureV2ForExclusiveField("WFED", s) || f.v2 == nil {
		return
	}
	f.v2.Set(&id3v2.URLFrame{FrameID: "WFED", URL: s})
}

func (f *File) setPodcastText(id, value string) {
	if value == "" {
		if f.v2 != nil {
			f.v2.Remove(id)
		}
		return
	}
	if !f.ensureV2ForExclusiveField(id, value) || f.v2 == nil {
		return
	}
	f.v2.SetText(id, value)
}

// SetRating writes a 0-255 rating with email as the rater identifier.
func (f *File) SetRating(email string, rating byte) {
	if rating == 0 && email == "" {
		if f.v2 != nil {
			if existing, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok && existing != nil && existing.Count > 0 {
				copyPop := *existing
				copyPop.Rating = 0
				f.v2.Set(&copyPop)
			} else {
				f.v2.Remove(id3v2.FramePopularimeter)
			}
		}
		return
	}
	if !f.ensureV2ForExclusiveField(id3v2.FramePopularimeter, fmt.Sprintf("%s/%d", email, rating)) {
		return
	}
	pop := &id3v2.PopularimeterFrame{Email: email, Rating: rating}
	if existing, ok := f.v2.Find(id3v2.FramePopularimeter).(*id3v2.PopularimeterFrame); ok && existing != nil {
		pop.Count = existing.Count
		if pop.Email == "" {
			pop.Email = existing.Email
		}
	}
	f.v2.Set(pop)
}
