package mtag

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v2"
)

const musicBrainzUFIDOwner = "http://musicbrainz.org"

// MusicBrainzField identifies one of the common MusicBrainz IDs.
type MusicBrainzField uint8

const (
	MusicBrainzRecordingID MusicBrainzField = iota + 1
	MusicBrainzTrackID
	MusicBrainzReleaseID
	MusicBrainzReleaseGroupID
	MusicBrainzArtistID
	MusicBrainzAlbumArtistID
	MusicBrainzWorkID
	MusicBrainzReleaseType

	// Alias for callers that prefer release-artist terminology.
	MusicBrainzReleaseArtistID = MusicBrainzAlbumArtistID
)

func (k MusicBrainzField) String() string {
	switch k {
	case MusicBrainzRecordingID:
		return "recording-id"
	case MusicBrainzTrackID:
		return "track-id"
	case MusicBrainzReleaseID:
		return "release-id"
	case MusicBrainzReleaseGroupID:
		return "release-group-id"
	case MusicBrainzArtistID:
		return "artist-id"
	case MusicBrainzAlbumArtistID:
		return "album-artist-id"
	case MusicBrainzWorkID:
		return "work-id"
	case MusicBrainzReleaseType:
		return "release-type"
	}
	return "unknown"
}

// MusicBrainzID returns the first matching MusicBrainz value it can
// find in the file's metadata stores. Recording IDs prefer the
// `http://musicbrainz.org` UFID owner on ID3v2.
func (f *File) MusicBrainzID(kind MusicBrainzField) string {
	if f.v2 != nil {
		if kind == MusicBrainzRecordingID {
			if s := f.ufidValue(musicBrainzUFIDOwner); s != "" {
				return s
			}
		}
		for _, desc := range musicBrainzID3Descriptions(kind) {
			if s := f.userTextValue(desc); s != "" {
				return s
			}
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		for _, name := range musicBrainzVorbisNames(kind) {
			if s := f.flac.comment.Get(name); s != "" {
				return s
			}
		}
	}
	if f.mkv != nil {
		for _, name := range musicBrainzVorbisNames(kind) {
			if s := f.mkv.Get(name); s != "" {
				return s
			}
		}
	}
	if f.mp4 != nil {
		for _, name := range musicBrainzMP4Names(kind) {
			if vals := f.mp4FreeformValues(mp4FreeformMeanITunes, name); len(vals) > 0 {
				return vals[0]
			}
		}
	}
	if f.ape != nil {
		for _, name := range musicBrainzAPENames(kind) {
			if fld := f.ape.Find(name); fld != nil && fld.IsText() {
				values := fld.TextValues()
				if len(values) > 0 {
					return values[0]
				}
				if s := fld.Text(); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

// SetMusicBrainzID writes one MusicBrainz value to the file's
// native metadata store. MP4 uses iTunes freeform atoms, FLAC/OGG
// use Vorbis Comments, APE-native containers use APE fields, and
// ID3-backed containers use UFID/TXXX as appropriate.
func (f *File) SetMusicBrainzID(kind MusicBrainzField, value string) {
	container := f.Container()
	switch {
	case container == ContainerFLAC || container == ContainerOGG:
		f.ensureFLAC()
		names := musicBrainzVorbisNames(kind)
		setVorbisValues(f.flac.comment, names[0], singleOrNone(value))
		for _, alias := range names[1:] {
			f.flac.comment.Set(alias, "")
		}
		return
	case container == ContainerMatroska:
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		names := musicBrainzVorbisNames(kind)
		f.mkv.setAll(names[0], singleOrNone(value))
		for _, alias := range names[1:] {
			f.mkv.Set(alias, "")
		}
		return
	case container == ContainerMP4:
		f.ensureMP4()
		names := musicBrainzMP4Names(kind)
		f.mp4SetFreeform(mp4FreeformMeanITunes, names[0], singleOrNone(value)...)
		for _, alias := range names[1:] {
			f.mp4RemoveFreeform(mp4FreeformMeanITunes, alias)
		}
		return
	case isAPEContainer(container) || (f.ape != nil && f.v2 == nil):
		f.ensureAPE()
		names := musicBrainzAPENames(kind)
		setAPETextValues(f.ape, names[0], singleOrNone(value))
		for _, alias := range names[1:] {
			f.ape.Remove(alias)
		}
		return
	}

	if kind == MusicBrainzRecordingID {
		f.setUFID(musicBrainzUFIDOwner, []byte(value))
		for _, desc := range musicBrainzID3Descriptions(kind) {
			f.removeUserText(desc)
		}
		return
	}
	descs := musicBrainzID3Descriptions(kind)
	f.setUserTextValues(descs[0], singleOrNone(value)...)
	for _, alias := range descs[1:] {
		f.removeUserText(alias)
	}
}

// CustomValue returns the first value of a custom text field.
func (f *File) CustomValue(name string) string {
	values := f.CustomValues(name)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// CustomValues reads an arbitrary user-defined text field from the
// available metadata stores. For ID3v2, name addresses the TXXX
// description. For MP4, name can be either a plain iTunes freeform
// identifier ("replaygain_track_gain") or an explicit
// "----:mean:name" key.
func (f *File) CustomValues(name string) []string {
	if name == "" {
		return nil
	}
	id3Name := normaliseID3CustomName(name)
	if f.v2 != nil {
		if vals := f.userTextValues(id3Name); len(vals) > 0 {
			return vals
		}
	}
	if f.flac != nil && f.flac.comment != nil {
		if vals := firstMappedValues(f.flac.comment, name); len(vals) > 0 {
			return vals
		}
	}
	if f.mkv != nil {
		if vals := firstMappedValues(f.mkv, name, strings.ToUpper(name)); len(vals) > 0 {
			return vals
		}
	}
	if f.tracker != nil {
		if vals := firstMappedValues(f.tracker, name, strings.ToUpper(name)); len(vals) > 0 {
			return vals
		}
	}
	if f.asf != nil {
		if vals := firstMappedValues(f.asf, name); len(vals) > 0 {
			return vals
		}
	}
	if f.realMedia != nil {
		if vals := firstMappedValues(f.realMedia, name); len(vals) > 0 {
			return vals
		}
	}
	if f.mp4 != nil {
		mean, atom := normaliseMP4CustomName(name)
		if vals := f.mp4FreeformValues(mean, atom); len(vals) > 0 {
			return vals
		}
	}
	if f.ape != nil {
		if fld := f.ape.Find(name); fld != nil && fld.IsText() {
			vals := fld.TextValues()
			if len(vals) == 0 && fld.Text() != "" {
				vals = []string{fld.Text()}
			}
			return append([]string(nil), vals...)
		}
	}
	return nil
}

// SetCustomValues writes a user-defined text field to the file's
// native metadata store. Passing no values removes the field.
func (f *File) SetCustomValues(name string, values ...string) {
	if name == "" {
		return
	}
	container := f.Container()
	switch {
	case container == ContainerFLAC || container == ContainerOGG:
		f.ensureFLAC()
		setVorbisValues(f.flac.comment, name, values)
		return
	case container == ContainerMatroska:
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		setMappedAll(f.mkv, []string{strings.ToUpper(name)}, values)
		return
	case container == ContainerASF:
		if f.asf == nil {
			f.asf = &asfView{}
		}
		setMappedAll(f.asf, []string{name}, values)
		return
	case isTrackerContainer(container):
		if len(values) > 0 {
			f.recordErr(fmt.Errorf("mtag: custom field %q dropped: tracker containers do not support native custom fields", name))
		}
		return
	case container == ContainerMP4:
		f.ensureMP4()
		mean, atom := normaliseMP4CustomName(name)
		f.mp4SetFreeform(mean, atom, values...)
		return
	case isAPEContainer(container) || (f.ape != nil && f.v2 == nil):
		f.ensureAPE()
		setAPETextValues(f.ape, name, values)
		return
	}
	f.setUserTextValues(normaliseID3CustomName(name), values...)
}

// RemoveCustom deletes a custom text field from the active metadata
// store.
func (f *File) RemoveCustom(name string) {
	f.SetCustomValues(name)
}

// CueSheet returns the FLAC CUESHEET block.
func (f *File) CueSheet() (*flac.CueSheet, bool) {
	if f.Container() != ContainerFLAC {
		return nil, false
	}
	blocks, _, err := flac.ReadBlocks(f.src, f.size)
	if err != nil {
		return nil, false
	}
	for _, blk := range blocks {
		if blk.Type != flac.BlockCueSheet {
			continue
		}
		cs, err := flac.DecodeCueSheet(blk.Body)
		if err != nil {
			return nil, false
		}
		return cs, true
	}
	return nil, false
}

func (f *File) replayGainFromNative(scope string) (ReplayGain, bool) {
	rg := ReplayGain{Gain: math.NaN(), Peak: math.NaN()}
	found := false
	gainKey := "REPLAYGAIN_" + scope + "_GAIN"
	peakKey := "REPLAYGAIN_" + scope + "_PEAK"

	if f.flac != nil && f.flac.comment != nil {
		if g, ok := replayGainFromStrings(f.flac.comment.GetAll(gainKey)); ok {
			rg.Gain = g
			found = true
		}
		if p, ok := replayPeakFromStrings(f.flac.comment.GetAll(peakKey)); ok {
			rg.Peak = p
			found = true
		}
	}
	if f.mkv != nil {
		if g, ok := replayGainFromStrings(f.mkv.GetAll(gainKey)); ok {
			rg.Gain = g
			found = true
		}
		if p, ok := replayPeakFromStrings(f.mkv.GetAll(peakKey)); ok {
			rg.Peak = p
			found = true
		}
	}
	if f.mp4 != nil {
		if g, ok := replayGainFromStrings(f.mp4FreeformValues(mp4FreeformMeanITunes, strings.ToLower(gainKey))); ok {
			rg.Gain = g
			found = true
		}
		if p, ok := replayPeakFromStrings(f.mp4FreeformValues(mp4FreeformMeanITunes, strings.ToLower(peakKey))); ok {
			rg.Peak = p
			found = true
		}
	}
	if f.ape != nil {
		if fld := f.ape.Find(gainKey); fld != nil && fld.IsText() {
			if g, ok := replayGainFromStrings(fld.TextValues()); ok {
				rg.Gain = g
				found = true
			}
		}
		if fld := f.ape.Find(peakKey); fld != nil && fld.IsText() {
			if p, ok := replayPeakFromStrings(fld.TextValues()); ok {
				rg.Peak = p
				found = true
			}
		}
	}
	if f.asf != nil {
		if g, ok := replayGainFromStrings(f.asf.GetAll(gainKey)); ok {
			rg.Gain = g
			found = true
		}
		if p, ok := replayPeakFromStrings(f.asf.GetAll(peakKey)); ok {
			rg.Peak = p
			found = true
		}
	}
	return rg, found
}

func (f *File) setReplayGainNative(scope string, rg ReplayGain) bool {
	gainKey := "REPLAYGAIN_" + scope + "_GAIN"
	peakKey := "REPLAYGAIN_" + scope + "_PEAK"
	container := f.Container()
	switch {
	case container == ContainerFLAC || container == ContainerOGG:
		f.ensureFLAC()
		setVorbisValues(f.flac.comment, gainKey, replayGainValues(rg.Gain, "%+.2f dB"))
		setVorbisValues(f.flac.comment, peakKey, replayGainValues(rg.Peak, "%.6f"))
		return true
	case container == ContainerMatroska:
		if f.mkv == nil {
			f.mkv = &matroskaView{}
		}
		f.mkv.setAll(gainKey, replayGainValues(rg.Gain, "%+.2f dB"))
		f.mkv.setAll(peakKey, replayGainValues(rg.Peak, "%.6f"))
		return true
	case container == ContainerASF:
		if f.asf == nil {
			f.asf = &asfView{}
		}
		f.asf.setAll(gainKey, replayGainValues(rg.Gain, "%+.2f dB"))
		f.asf.setAll(peakKey, replayGainValues(rg.Peak, "%.6f"))
		return true
	case container == ContainerMP4:
		f.ensureMP4()
		f.mp4SetFreeform(mp4FreeformMeanITunes, strings.ToLower(gainKey), replayGainValues(rg.Gain, "%+.2f dB")...)
		f.mp4SetFreeform(mp4FreeformMeanITunes, strings.ToLower(peakKey), replayGainValues(rg.Peak, "%.6f")...)
		return true
	case isAPEContainer(container) || (f.ape != nil && f.v2 == nil):
		f.ensureAPE()
		setAPETextValues(f.ape, gainKey, replayGainValues(rg.Gain, "%+.2f dB"))
		setAPETextValues(f.ape, peakKey, replayGainValues(rg.Peak, "%.6f"))
		return true
	}
	return false
}

func replayGainValues(v float64, format string) []string {
	if math.IsNaN(v) {
		return nil
	}
	return []string{fmt.Sprintf(format, v)}
}

func replayGainFromStrings(values []string) (float64, bool) {
	for _, v := range values {
		if g, ok := parseReplayGainGain(v); ok {
			return g, true
		}
	}
	return 0, false
}

func replayPeakFromStrings(values []string) (float64, bool) {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if p, err := strconv.ParseFloat(v, 64); err == nil {
			return p, true
		}
	}
	return 0, false
}

func setVorbisValues(v *flac.VorbisComment, name string, values []string) {
	kept := v.Fields[:0]
	for _, fld := range v.Fields {
		if !strings.EqualFold(fld.Name, name) {
			kept = append(kept, fld)
		}
	}
	v.Fields = kept
	if len(values) == 0 {
		return
	}
	upper := strings.ToUpper(name)
	for _, value := range values {
		v.Fields = append(v.Fields, flac.Field{Name: upper, Value: value})
	}
}

func setAPETextValues(t *ape.Tag, name string, values []string) {
	t.Remove(name)
	if len(values) == 0 {
		return
	}
	t.Set(name, strings.Join(values, "\x00"))
}

func singleOrNone(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}

func normaliseID3CustomName(name string) string {
	if len(name) >= 5 && strings.EqualFold(name[:5], "TXXX:") {
		return name[5:]
	}
	return name
}

func normaliseMP4CustomName(name string) (mean, atom string) {
	if mean, atom, ok := parseMP4FreeformKey(name); ok {
		return mean, atom
	}
	return mp4FreeformMeanITunes, name
}

func (f *File) userTextValues(desc string) []string {
	if f.v2 == nil {
		return nil
	}
	for _, fr := range f.v2.FindAll(id3v2.FrameUserText) {
		u, ok := fr.(*id3v2.UserTextFrame)
		if !ok || !strings.EqualFold(u.Description, desc) {
			continue
		}
		return append([]string(nil), u.Values...)
	}
	return nil
}

func (f *File) setUserTextValues(desc string, values ...string) {
	if len(values) > 0 && !f.ensureV2ForExclusiveField("TXXX:"+desc, values[0]) {
		return
	}
	if f.v2 == nil {
		return
	}
	f.removeUserText(desc)
	if len(values) == 0 {
		return
	}
	copied := append([]string(nil), values...)
	f.v2.Frames = append(f.v2.Frames, &id3v2.UserTextFrame{
		Description: desc,
		Values:      copied,
	})
}

func (f *File) ufidValue(owner string) string {
	if f.v2 == nil {
		return ""
	}
	for _, fr := range f.v2.FindAll(id3v2.FrameUFID) {
		ufid, ok := fr.(*id3v2.UniqueFileIDFrame)
		if ok && strings.EqualFold(ufid.Owner, owner) {
			return string(ufid.Identifier)
		}
	}
	return ""
}

func (f *File) removeUFID(owner string) {
	if f.v2 == nil {
		return
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		if ufid, ok := fr.(*id3v2.UniqueFileIDFrame); ok && strings.EqualFold(ufid.Owner, owner) {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
}

func (f *File) setUFID(owner string, identifier []byte) {
	if len(identifier) > 0 && !f.ensureV2ForExclusiveField("UFID:"+owner, string(identifier)) {
		return
	}
	if f.v2 == nil {
		return
	}
	f.removeUFID(owner)
	if len(identifier) == 0 {
		return
	}
	f.v2.Frames = append(f.v2.Frames, &id3v2.UniqueFileIDFrame{
		Owner:      owner,
		Identifier: append([]byte(nil), identifier...),
	})
}

func musicBrainzID3Descriptions(kind MusicBrainzField) []string {
	switch kind {
	case MusicBrainzRecordingID:
		return []string{"MusicBrainz Track Id", "MUSICBRAINZ_TRACKID"}
	case MusicBrainzTrackID:
		return []string{"MusicBrainz Release Track Id", "MUSICBRAINZ_RELEASETRACKID"}
	case MusicBrainzReleaseID:
		return []string{"MusicBrainz Album Id", "MUSICBRAINZ_ALBUMID"}
	case MusicBrainzReleaseGroupID:
		return []string{"MusicBrainz Release Group Id", "MUSICBRAINZ_RELEASEGROUPID"}
	case MusicBrainzArtistID:
		return []string{"MusicBrainz Artist Id", "MUSICBRAINZ_ARTISTID"}
	case MusicBrainzAlbumArtistID:
		return []string{"MusicBrainz Album Artist Id", "MUSICBRAINZ_ALBUMARTISTID"}
	case MusicBrainzWorkID:
		return []string{"MusicBrainz Work Id", "MUSICBRAINZ_WORKID"}
	case MusicBrainzReleaseType:
		return []string{"MusicBrainz Album Type", "MUSICBRAINZ_ALBUMTYPE"}
	}
	return []string{kind.String()}
}

func musicBrainzVorbisNames(kind MusicBrainzField) []string {
	switch kind {
	case MusicBrainzRecordingID:
		return []string{"MUSICBRAINZ_TRACKID"}
	case MusicBrainzTrackID:
		return []string{"MUSICBRAINZ_RELEASETRACKID"}
	case MusicBrainzReleaseID:
		return []string{"MUSICBRAINZ_ALBUMID"}
	case MusicBrainzReleaseGroupID:
		return []string{"MUSICBRAINZ_RELEASEGROUPID"}
	case MusicBrainzArtistID:
		return []string{"MUSICBRAINZ_ARTISTID"}
	case MusicBrainzAlbumArtistID:
		return []string{"MUSICBRAINZ_ALBUMARTISTID"}
	case MusicBrainzWorkID:
		return []string{"MUSICBRAINZ_WORKID"}
	case MusicBrainzReleaseType:
		return []string{"RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE"}
	}
	return []string{strings.ToUpper(kind.String())}
}

func musicBrainzAPENames(kind MusicBrainzField) []string {
	switch kind {
	case MusicBrainzRecordingID:
		return []string{"MUSICBRAINZ_TRACKID"}
	case MusicBrainzTrackID:
		return []string{"MUSICBRAINZ_RELEASETRACKID"}
	case MusicBrainzReleaseID:
		return []string{"MUSICBRAINZ_ALBUMID"}
	case MusicBrainzReleaseGroupID:
		return []string{"MUSICBRAINZ_RELEASEGROUPID"}
	case MusicBrainzArtistID:
		return []string{"MUSICBRAINZ_ARTISTID"}
	case MusicBrainzAlbumArtistID:
		return []string{"MUSICBRAINZ_ALBUMARTISTID"}
	case MusicBrainzWorkID:
		return []string{"MUSICBRAINZ_WORKID"}
	case MusicBrainzReleaseType:
		return []string{"MUSICBRAINZ_ALBUMTYPE"}
	}
	return []string{strings.ToUpper(kind.String())}
}

func musicBrainzMP4Names(kind MusicBrainzField) []string {
	switch kind {
	case MusicBrainzRecordingID:
		return []string{"MusicBrainz Track Id"}
	case MusicBrainzTrackID:
		return []string{"MusicBrainz Release Track Id"}
	case MusicBrainzReleaseID:
		return []string{"MusicBrainz Album Id"}
	case MusicBrainzReleaseGroupID:
		return []string{"MusicBrainz Release Group Id"}
	case MusicBrainzArtistID:
		return []string{"MusicBrainz Artist Id"}
	case MusicBrainzAlbumArtistID:
		return []string{"MusicBrainz Album Artist Id"}
	case MusicBrainzWorkID:
		return []string{"MusicBrainz Work Id"}
	case MusicBrainzReleaseType:
		return []string{"MusicBrainz Album Type"}
	}
	return []string{kind.String()}
}
