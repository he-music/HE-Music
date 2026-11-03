package mtag

import (
	"strings"

	"github.com/tommyo123/mtag/id3v2"
)

// OpenMGObject is one Sony OpenMG-specific GEOB payload carried in
// an OMA / ATRAC tag.
type OpenMGObject struct {
	Description string
	MIME        string
	Filename    string
	Data        []byte
}

// OpenMGMetadata is the typed view of the OpenMG-specific metadata
// fields commonly found in OMA / ATRAC files.
type OpenMGMetadata struct {
	Track       string
	AlbumGenre  string
	AlbumArtist string
	Objects     []OpenMGObject
}

// Object returns the first OpenMG GEOB payload whose description
// matches desc, case-insensitively.
func (m *OpenMGMetadata) Object(desc string) (OpenMGObject, bool) {
	if m == nil {
		return OpenMGObject{}, false
	}
	for _, obj := range m.Objects {
		if strings.EqualFold(obj.Description, desc) {
			return obj, true
		}
	}
	return OpenMGObject{}, false
}

// OpenMG returns the Sony-specific OpenMG metadata carried in an
// ID3v2-compatible OMA / ATRAC tag. The standard title / artist /
// album / genre fields stay available through the regular
// polymorphic API; this accessor only exposes the OpenMG-specific
// TXXX / GEOB additions.
func (f *File) OpenMG() (*OpenMGMetadata, bool) {
	if f.v2 == nil {
		return nil, false
	}
	out := &OpenMGMetadata{
		Track:       f.userTextValue("OMG_TRACK"),
		AlbumGenre:  f.userTextValue("OMG_AGENR"),
		AlbumArtist: f.userTextValue("OMG_ATPE1"),
	}
	for _, fr := range f.v2.FindAll(id3v2.FrameGEOB) {
		obj, ok := fr.(*id3v2.GeneralObjectFrame)
		if !ok || !strings.HasPrefix(strings.ToUpper(obj.Description), "OMG_") {
			continue
		}
		out.Objects = append(out.Objects, OpenMGObject{
			Description: obj.Description,
			MIME:        obj.MIME,
			Filename:    obj.Filename,
			Data:        append([]byte(nil), obj.Data...),
		})
	}
	if out.Track == "" && out.AlbumGenre == "" && out.AlbumArtist == "" && len(out.Objects) == 0 {
		return nil, false
	}
	return out, true
}

// SetOpenMGTrack writes the Sony-specific OMG_TRACK user-text field.
func (f *File) SetOpenMGTrack(value string) {
	f.setUserTextValues("OMG_TRACK", singleOrNone(value)...)
}

// SetOpenMGAlbumGenre writes the Sony-specific OMG_AGENR user-text field.
func (f *File) SetOpenMGAlbumGenre(value string) {
	f.setUserTextValues("OMG_AGENR", singleOrNone(value)...)
}

// SetOpenMGAlbumArtist writes the Sony-specific OMG_ATPE1 user-text field.
func (f *File) SetOpenMGAlbumArtist(value string) {
	f.setUserTextValues("OMG_ATPE1", singleOrNone(value)...)
}

// SetOpenMGObject writes one Sony-specific GEOB payload identified by
// its description. Passing nil data removes the object.
func (f *File) SetOpenMGObject(description, mime, filename string, data []byte) {
	description = strings.TrimSpace(description)
	if description == "" {
		return
	}
	if len(data) > 0 && !f.ensureV2ForExclusiveField(id3v2.FrameGEOB+":"+description, mime) {
		return
	}
	if f.v2 == nil && len(data) == 0 {
		return
	}
	if f.v2 == nil {
		f.ensureV2()
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		if obj, ok := fr.(*id3v2.GeneralObjectFrame); ok && strings.EqualFold(obj.Description, description) {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
	if len(data) == 0 {
		return
	}
	f.v2.Frames = append(f.v2.Frames, &id3v2.GeneralObjectFrame{
		MIME:        mime,
		Filename:    filename,
		Description: description,
		Data:        append([]byte(nil), data...),
	})
}

// RemoveOpenMGObject removes every Sony-specific GEOB payload whose
// description matches description, case-insensitively.
func (f *File) RemoveOpenMGObject(description string) {
	f.SetOpenMGObject(description, "", "", nil)
}
