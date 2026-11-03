package mtag

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

// TagKind identifies which tag format a [Tag] is a view onto. The
// zero value is reserved so callers can distinguish "not set".
type TagKind uint8

const (
	TagID3v1     TagKind = iota + 1 // legacy ID3v1 / ID3v1.1 footer
	TagID3v2                        // ID3v2.2 / 2.3 / 2.4 header or footer
	TagVorbis                       // Vorbis Comments (FLAC and OGG)
	TagMP4                          // iTunes-style ilst items inside an MP4 moov
	TagMatroska                     // Matroska / WebM Segment Tags
	TagTracker                      // Native module text fields (MOD/XM/IT/S3M)
	TagAPE                          // APEv1 / APEv2 key/value tag
	TagRIFFInfo                     // WAV LIST-INFO subchunk (INAM/IART/...)
	TagAIFFText                     // AIFF NAME/AUTH/ANNO/(c) chunks
	TagBWF                          // Broadcast Wave chunks (bext/iXML/axml/cart)
	TagASF                          // ASF/WMA Content Description + descriptor fields
	TagRealMedia                    // RealAudio / RealMedia CONT metadata
	TagCAF                          // Apple Core Audio Format "info" chunk
)

// String renders the kind in the short form used by [Tag.Kind]
// consumers such as diff tools.
func (k TagKind) String() string {
	switch k {
	case TagID3v1:
		return "id3v1"
	case TagID3v2:
		return "id3v2"
	case TagVorbis:
		return "vorbis"
	case TagMP4:
		return "mp4"
	case TagMatroska:
		return "matroska"
	case TagTracker:
		return "tracker"
	case TagAPE:
		return "ape"
	case TagRIFFInfo:
		return "riff-info"
	case TagAIFFText:
		return "aiff-text"
	case TagBWF:
		return "bwf"
	case TagASF:
		return "asf"
	case TagRealMedia:
		return "realmedia"
	case TagCAF:
		return "caf"
	}
	return "unknown"
}

// Tag is a read-only polymorphic view onto one tag store. It lets
// callers iterate or copy every field of a file without knowing the
// underlying format. Field names are reported in each format's
// native convention:
//
//   - ID3v1: lower-case short names ("title", "artist", ...)
//   - ID3v2: four-letter frame IDs ("TIT2", "TPE1", ...)
//   - Vorbis: upper-case tag names ("TITLE", "ARTIST", ...)
//   - MP4: four-byte ilst identifiers (e.g. "\xa9nam")
//   - Matroska: EBML SimpleTag names ("TITLE", "ARTIST", ...)
//   - Tracker: module-native text keys ("TITLE", "COMMENT", "TRACKERNAME")
//   - APE: case-preserved labels ("Title", "Artist")
//   - BWF: chunk-oriented keys ("bext.description", "ixml", ...)
//   - ASF: descriptor names ("Title", "WM/AlbumTitle", ...)
//   - RealMedia: CONT field names ("Title", "Author", ...)
//
// Writes still go through the polymorphic setters on [*File]
// (SetTitle, SetArtist, ...) because Tag is intentionally read-only so the
// type-specific validation rules live in one place.
type Tag interface {
	Kind() TagKind
	Keys() []string
	Get(name string) string
}

// Tags returns one [Tag] per store present in the file, in the
// canonical priority order mtag uses for reads (ID3v2 -> Vorbis ->
// MP4 -> APE -> ID3v1). Absent stores are skipped.
func (f *File) Tags() []Tag {
	var out []Tag
	if f.v2 != nil && len(f.v2.Frames) > 0 {
		out = append(out, &id3v2TagView{f.v2})
	}
	if f.flac != nil && f.flac.comment != nil && len(f.flac.comment.Fields) > 0 {
		out = append(out, &vorbisTagView{f.flac.comment})
	}
	if f.mp4 != nil && len(f.mp4.items) > 0 {
		out = append(out, &mp4TagView{f.mp4})
	}
	if f.mkv != nil {
		if tv := (&matroskaTagView{f.mkv}); len(tv.Keys()) > 0 {
			out = append(out, tv)
		}
	}
	if f.tracker != nil && len(f.tracker.Fields) > 0 {
		out = append(out, &trackerTagView{f.tracker})
	}
	if f.ape != nil && len(f.ape.Fields) > 0 {
		out = append(out, &apeTagView{f.ape})
	}
	if f.riffInfo != nil && len(f.riffInfo.keys) > 0 {
		out = append(out, &riffInfoTagView{f.riffInfo})
	}
	if f.bwf != nil && !f.bwf.empty() {
		out = append(out, &bwfTagView{f.bwf})
	}
	if f.asf != nil && len(f.asf.Fields) > 0 {
		out = append(out, &asfTagView{f.asf})
	}
	if f.realMedia != nil && len(f.realMedia.Fields) > 0 {
		out = append(out, &realMediaTagView{f.realMedia})
	}
	if f.caf != nil && len(f.caf.keys) > 0 {
		out = append(out, &cafTagView{f.caf})
	}
	if f.v1 != nil {
		out = append(out, &id3v1TagView{f.v1})
	}
	return out
}

// Tag returns the view for a specific [TagKind], or nil when the
// file does not carry that store.
func (f *File) Tag(kind TagKind) Tag {
	for _, t := range f.Tags() {
		if t.Kind() == kind {
			return t
		}
	}
	return nil
}

// -- concrete Tag implementations --------------------------------------

type id3v1TagView struct{ t *id3v1.Tag }

func (v *id3v1TagView) Kind() TagKind { return TagID3v1 }
func (v *id3v1TagView) Keys() []string {
	out := []string{"title", "artist", "album", "year", "comment", "genre"}
	if v.t.HasTrack() {
		out = append(out, "track")
	}
	return out
}
func (v *id3v1TagView) Get(name string) string {
	switch strings.ToLower(name) {
	case "title":
		return v.t.Title
	case "artist":
		return v.t.Artist
	case "album":
		return v.t.Album
	case "year":
		return v.t.Year
	case "comment":
		return v.t.Comment
	case "genre":
		return v.t.GenreName()
	case "track":
		if v.t.HasTrack() {
			return strconv.Itoa(int(v.t.Track))
		}
	}
	return ""
}

type id3v2TagView struct{ t *id3v2.Tag }

func (v *id3v2TagView) Kind() TagKind { return TagID3v2 }
func (v *id3v2TagView) Keys() []string {
	seen := make(map[string]bool, len(v.t.Frames))
	out := make([]string, 0, len(v.t.Frames))
	for _, fr := range v.t.Frames {
		id := fr.ID()
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
func (v *id3v2TagView) Get(name string) string {
	// Text frames go through Text(); comments and URLs are stringified.
	if s := v.t.Text(name); s != "" {
		return s
	}
	fr := v.t.Find(name)
	if fr == nil {
		return ""
	}
	switch f := fr.(type) {
	case *id3v2.CommentFrame:
		return f.Text
	case *id3v2.URLFrame:
		return f.URL
	case *id3v2.UserURLFrame:
		return f.URL
	case *id3v2.UserTextFrame:
		if len(f.Values) > 0 {
			return f.Values[0]
		}
	case *id3v2.PopularimeterFrame:
		return fmt.Sprintf("%d", f.Rating)
	case *id3v2.PlayCountFrame:
		return strconv.FormatUint(f.Count, 10)
	}
	return ""
}

type vorbisTagView struct{ c *flac.VorbisComment }

func (v *vorbisTagView) Kind() TagKind { return TagVorbis }
func (v *vorbisTagView) Keys() []string {
	out := make([]string, 0, len(v.c.Fields))
	seen := make(map[string]bool, len(v.c.Fields))
	for _, f := range v.c.Fields {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}
func (v *vorbisTagView) Get(name string) string { return v.c.Get(name) }

type mp4TagView struct{ m *mp4View }

func (v *mp4TagView) Kind() TagKind { return TagMP4 }
func (v *mp4TagView) Keys() []string {
	out := make([]string, 0, len(v.m.items)+len(v.m.mdta))
	seen := make(map[string]bool, len(v.m.items)+len(v.m.mdta))
	for _, it := range v.m.items {
		k := it.Key()
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for _, it := range v.m.mdta {
		k := "mdta:" + it.Key
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}
func (v *mp4TagView) Get(name string) string {
	if strings.HasPrefix(name, "mdta:") {
		key := strings.TrimPrefix(name, "mdta:")
		for _, it := range v.m.mdta {
			if !strings.EqualFold(it.Key, key) {
				continue
			}
			switch it.Type {
			case mp4.DataUTF8, mp4.DataUTF16:
				return string(it.Data)
			case mp4.DataInteger:
				if n, ok := mp4DecodeInteger(it.Data); ok {
					return strconv.FormatInt(n, 10)
				}
			}
		}
		return ""
	}
	for _, it := range v.m.items {
		if it.Key() != name {
			continue
		}
		switch it.Type {
		case mp4.DataUTF8, mp4.DataUTF16:
			return string(it.Data)
		case mp4.DataInteger:
			var u int64
			for _, b := range it.Data {
				u = (u << 8) | int64(b)
			}
			return strconv.FormatInt(u, 10)
		default:
			return string(it.Data)
		}
	}
	return ""
}

type apeTagView struct{ t *ape.Tag }

func (v *apeTagView) Kind() TagKind { return TagAPE }
func (v *apeTagView) Keys() []string {
	out := make([]string, 0, len(v.t.Fields))
	seen := make(map[string]bool, len(v.t.Fields))
	for _, f := range v.t.Fields {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}
func (v *apeTagView) Get(name string) string {
	if v == nil || v.t == nil {
		return ""
	}
	if f := v.t.Find(name); f != nil && f.IsText() {
		if vals := f.TextValues(); len(vals) > 0 {
			return vals[0]
		}
		return f.Text()
	}
	return ""
}

type asfTagView struct{ v *asfView }

func (v *asfTagView) Kind() TagKind { return TagASF }
func (v *asfTagView) Keys() []string {
	out := make([]string, 0, len(v.v.Fields))
	seen := make(map[string]bool, len(v.v.Fields))
	for _, f := range v.v.Fields {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}
func (v *asfTagView) Get(name string) string { return v.v.Get(name) }
