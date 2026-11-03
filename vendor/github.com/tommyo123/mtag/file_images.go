package mtag

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

// Images returns every attached picture, ordered as stored.
func (f *File) Images() []Picture {
	if f.v2 != nil {
		var out []Picture
		for _, fr := range f.v2.Frames {
			if pf, ok := fr.(*id3v2.PictureFrame); ok {
				out = append(out, Picture{
					MIME:        pf.MIME,
					Type:        PictureType(pf.PictureType),
					Description: pf.Description,
					Data:        append([]byte(nil), pf.Data...),
				})
			}
		}
		return out
	}
	if f.flac != nil {
		out := make([]Picture, 0, len(f.flac.pictures))
		for _, p := range f.flac.pictures {
			out = append(out, Picture{
				MIME:        p.MIME,
				Type:        PictureType(p.Type),
				Description: p.Description,
				Data:        append([]byte(nil), p.Data...),
			})
		}
		if f.container.Kind() == ContainerOGG && f.flac.comment != nil {
			for _, mbp := range f.flac.comment.GetAll("METADATA_BLOCK_PICTURE") {
				if p, ok := decodeMetadataBlockPicture(mbp); ok {
					out = append(out, p)
				}
			}
		}
		return out
	}
	if f.mp4 != nil {
		return f.mp4Pictures()
	}
	if f.asf != nil && len(f.asf.Pictures) > 0 {
		out := make([]Picture, 0, len(f.asf.Pictures))
		for _, p := range f.asf.Pictures {
			out = append(out, Picture{
				MIME:        p.MIME,
				Type:        p.Type,
				Description: p.Description,
				Data:        append([]byte(nil), p.Data...),
			})
		}
		return out
	}
	if f.mkv != nil && len(f.mkv.Pictures) > 0 {
		out := make([]Picture, 0, len(f.mkv.Pictures))
		for _, p := range f.mkv.Pictures {
			out = append(out, Picture{
				MIME:        p.MIME,
				Type:        p.Type,
				Description: p.Description,
				Data:        append([]byte(nil), p.Data...),
			})
		}
		return out
	}
	if f.ape != nil {
		return apePictures(f.ape)
	}
	return nil
}

// ImageSummaries returns one summary per embedded picture without
// copying the picture payloads.
func (f *File) ImageSummaries() []ImageSummary {
	if f.v2 != nil {
		var out []ImageSummary
		for _, fr := range f.v2.Frames {
			if pf, ok := fr.(*id3v2.PictureFrame); ok {
				out = append(out, ImageSummary{MIME: pf.MIME, Type: PictureType(pf.PictureType), Size: len(pf.Data)})
			}
		}
		return out
	}
	if f.flac != nil {
		out := make([]ImageSummary, 0, len(f.flac.pictures))
		for _, p := range f.flac.pictures {
			out = append(out, ImageSummary{MIME: p.MIME, Type: PictureType(p.Type), Size: len(p.Data)})
		}
		if f.container.Kind() == ContainerOGG && f.flac.comment != nil {
			for _, mbp := range f.flac.comment.GetAll("METADATA_BLOCK_PICTURE") {
				if p, ok := decodeMetadataBlockPicture(mbp); ok {
					out = append(out, ImageSummary{MIME: p.MIME, Type: p.Type, Size: len(p.Data)})
				}
			}
		}
		return out
	}
	if f.mp4 != nil {
		var out []ImageSummary
		for _, it := range f.mp4.items {
			if it.Key() != "covr" {
				continue
			}
			mime := "image/jpeg"
			if it.Type == mp4.DataPNG {
				mime = "image/png"
			}
			out = append(out, ImageSummary{MIME: mime, Type: PictureCoverFront, Size: len(it.Data)})
		}
		return out
	}
	if f.asf != nil && len(f.asf.Pictures) > 0 {
		out := make([]ImageSummary, 0, len(f.asf.Pictures))
		for _, p := range f.asf.Pictures {
			out = append(out, ImageSummary{MIME: p.MIME, Type: p.Type, Size: len(p.Data)})
		}
		return out
	}
	if f.mkv != nil && len(f.mkv.Pictures) > 0 {
		out := make([]ImageSummary, 0, len(f.mkv.Pictures))
		for _, p := range f.mkv.Pictures {
			out = append(out, ImageSummary{MIME: p.MIME, Type: p.Type, Size: len(p.Data)})
		}
		return out
	}
	if f.ape != nil {
		var out []ImageSummary
		collect := func(fieldName string, pt PictureType) {
			for i := range f.ape.Fields {
				field := &f.ape.Fields[i]
				if !field.IsBinary() || !strings.EqualFold(field.Name, fieldName) {
					continue
				}
				data := field.Value
				mime := "application/octet-stream"
				if nul := indexByte(data, 0); nul >= 0 {
					prefix := string(data[:nul])
					data = data[nul+1:]
					mime = guessImageMIME(prefix, data)
				}
				out = append(out, ImageSummary{MIME: mime, Type: pt, Size: len(data)})
			}
		}
		collect(ape.FieldCoverArtFront, PictureCoverFront)
		collect(ape.FieldCoverArtBack, PictureCoverBack)
		if len(out) == 0 {
			return nil
		}
		return out
	}
	return nil
}

func apePictures(t *ape.Tag) []Picture {
	var out []Picture
	collect := func(fieldName string, pt PictureType) {
		for i := range t.Fields {
			f := &t.Fields[i]
			if !f.IsBinary() {
				continue
			}
			if !strings.EqualFold(f.Name, fieldName) {
				continue
			}
			data := f.Value
			mime := "application/octet-stream"
			if nul := indexByte(data, 0); nul >= 0 {
				prefix := string(data[:nul])
				data = data[nul+1:]
				mime = guessImageMIME(prefix, data)
			}
			out = append(out, Picture{
				MIME: mime,
				Type: pt,
				Data: append([]byte(nil), data...),
			})
		}
	}
	collect(ape.FieldCoverArtFront, PictureCoverFront)
	collect(ape.FieldCoverArtBack, PictureCoverBack)
	return out
}

func guessImageMIME(prefix string, data []byte) string {
	ext := prefix
	if dot := strings.LastIndexByte(ext, '.'); dot >= 0 {
		ext = ext[dot+1:]
	}
	switch strings.ToLower(ext) {
	case "jpg", "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "bmp":
		return "image/bmp"
	}
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "image/jpeg"
	}
	if len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' {
		return "image/png"
	}
	return "application/octet-stream"
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

// AddImage appends a picture to the active writable metadata store.
func (f *File) AddImage(p Picture) {
	kind := f.Container()
	if kind == ContainerOGG {
		f.ensureFLAC()
		f.flac.comment.Fields = append(f.flac.comment.Fields, flac.Field{
			Name:  "METADATA_BLOCK_PICTURE",
			Value: encodeMetadataBlockPicture(p),
		})
		return
	}
	if kind == ContainerFLAC {
		f.ensureFLAC()
		f.flac.pictures = append(f.flac.pictures, &flac.Picture{
			Type:        uint32(p.Type),
			MIME:        p.MIME,
			Description: p.Description,
			Data:        append([]byte(nil), p.Data...),
		})
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		name := ape.FieldCoverArtFront
		if p.Type == PictureCoverBack {
			name = ape.FieldCoverArtBack
		}
		f.ape.SetBinary(name, apeWrapImage(p))
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		var n [4]byte
		copy(n[:], "covr")
		dt := mp4.DataJPEG
		if strings.EqualFold(p.MIME, "image/png") {
			dt = mp4.DataPNG
		}
		f.mp4.items = append(f.mp4.items, mp4.Item{
			Name: n,
			Type: dt,
			Data: append([]byte(nil), p.Data...),
		})
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		f.asf.Pictures = append(f.asf.Pictures, Picture{
			MIME:        p.MIME,
			Type:        p.Type,
			Description: p.Description,
			Data:        append([]byte(nil), p.Data...),
		})
		return
	}
	if kind == ContainerMatroska {
		f.ensureMatroska()
		f.addMatroskaImage(p)
		return
	}
	switch {
	case kind == ContainerRealMedia || isTrackerContainer(kind):
		f.recordErr(fmt.Errorf("mtag: image writes unsupported for %s", kind))
		return
	}
	if !f.ensureV2ForExclusiveField(id3v2.FramePicture, p.MIME) {
		return
	}
	f.v2.Frames = append(f.v2.Frames, &id3v2.PictureFrame{
		MIME:        p.MIME,
		PictureType: byte(p.Type),
		Description: p.Description,
		Data:        append([]byte(nil), p.Data...),
	})
}

func encodeMetadataBlockPicture(p Picture) string {
	fp := &flac.Picture{
		Type:        uint32(p.Type),
		MIME:        p.MIME,
		Description: p.Description,
		Data:        p.Data,
	}
	return base64.StdEncoding.EncodeToString(flac.EncodePicture(fp))
}

func decodeMetadataBlockPicture(s string) (Picture, bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return Picture{}, false
	}
	fp, err := flac.DecodePicture(raw)
	if err != nil {
		return Picture{}, false
	}
	return Picture{
		MIME:        fp.MIME,
		Type:        PictureType(fp.Type),
		Description: fp.Description,
		Data:        append([]byte(nil), fp.Data...),
	}, true
}

func apeWrapImage(p Picture) []byte {
	ext := "jpg"
	switch strings.ToLower(p.MIME) {
	case "image/png":
		ext = "png"
	case "image/gif":
		ext = "gif"
	case "image/bmp":
		ext = "bmp"
	}
	out := make([]byte, 0, len(ext)+1+len(p.Data))
	out = append(out, ext...)
	out = append(out, 0)
	out = append(out, p.Data...)
	return out
}

// SetCoverArt replaces every existing front-cover image with a new one.
func (f *File) SetCoverArt(mime string, data []byte) {
	kind := f.Container()
	if kind == ContainerOGG {
		f.ensureFLAC()
		kept := f.flac.comment.Fields[:0]
		for _, fld := range f.flac.comment.Fields {
			if strings.EqualFold(fld.Name, "METADATA_BLOCK_PICTURE") {
				if p, ok := decodeMetadataBlockPicture(fld.Value); ok && p.Type == PictureCoverFront {
					continue
				}
			}
			kept = append(kept, fld)
		}
		f.flac.comment.Fields = append(kept, flac.Field{
			Name:  "METADATA_BLOCK_PICTURE",
			Value: encodeMetadataBlockPicture(Picture{MIME: mime, Type: PictureCoverFront, Data: data}),
		})
		return
	}
	if kind == ContainerFLAC {
		f.ensureFLAC()
		kept := f.flac.pictures[:0]
		for _, p := range f.flac.pictures {
			if PictureType(p.Type) == PictureCoverFront {
				continue
			}
			kept = append(kept, p)
		}
		f.flac.pictures = append(kept, &flac.Picture{
			Type: uint32(PictureCoverFront),
			MIME: mime,
			Data: append([]byte(nil), data...),
		})
		return
	}
	if isAPEContainer(kind) {
		f.ensureAPE()
		f.ape.SetBinary(ape.FieldCoverArtFront, apeWrapImage(Picture{MIME: mime, Data: data}))
		return
	}
	if kind == ContainerMP4 {
		f.ensureMP4()
		f.mp4RemoveName("covr")
		f.AddImage(Picture{MIME: mime, Type: PictureCoverFront, Data: data})
		return
	}
	if kind == ContainerASF {
		if f.asf == nil {
			f.asf = &asfView{}
		}
		kept := f.asf.Pictures[:0]
		for _, p := range f.asf.Pictures {
			if p.Type == PictureCoverFront {
				continue
			}
			kept = append(kept, p)
		}
		f.asf.Pictures = append(kept, Picture{
			MIME: mime,
			Type: PictureCoverFront,
			Data: append([]byte(nil), data...),
		})
		return
	}
	if kind == ContainerMatroska {
		f.ensureMatroska()
		f.removeMatroskaImagesByType(PictureCoverFront)
		if len(data) > 0 {
			f.addMatroskaImage(Picture{
				MIME: mime,
				Type: PictureCoverFront,
				Data: append([]byte(nil), data...),
			})
		}
		return
	}
	switch {
	case kind == ContainerRealMedia || isTrackerContainer(kind):
		f.recordErr(fmt.Errorf("mtag: image writes unsupported for %s", kind))
		return
	}
	if len(data) > 0 && !f.ensureV2ForExclusiveField(id3v2.FramePicture, mime) {
		return
	}
	if f.v2 == nil {
		return
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		if pf, ok := fr.(*id3v2.PictureFrame); ok && pf.PictureType == byte(PictureCoverFront) {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
	f.v2.Frames = append(f.v2.Frames, &id3v2.PictureFrame{
		MIME:        mime,
		PictureType: byte(PictureCoverFront),
		Data:        append([]byte(nil), data...),
	})
}

// RemoveImages drops every embedded picture from the file.
func (f *File) RemoveImages() {
	kind := f.Container()
	if kind == ContainerOGG {
		if f.flac != nil && f.flac.comment != nil {
			f.flac.comment.Set("METADATA_BLOCK_PICTURE", "")
			f.flac.comment.Set("COVERART", "")
		}
		return
	}
	if kind == ContainerFLAC {
		if f.flac != nil {
			f.flac.pictures = nil
		}
		return
	}
	if isAPEContainer(kind) {
		if f.ape != nil {
			f.ape.Remove(ape.FieldCoverArtFront)
			f.ape.Remove(ape.FieldCoverArtBack)
		}
		return
	}
	if kind == ContainerMP4 {
		f.mp4RemoveName("covr")
		return
	}
	if kind == ContainerASF {
		if f.asf != nil {
			f.asf.Pictures = nil
		}
		return
	}
	if kind == ContainerMatroska {
		if f.mkv != nil {
			f.mkv.Attachments = retainMatroskaNonImageAttachments(f.mkv.Attachments)
			syncMatroskaPictures(f.mkv)
		}
		return
	}
	switch {
	case kind == ContainerRealMedia || isTrackerContainer(kind):
		f.recordErr(fmt.Errorf("mtag: image writes unsupported for %s", kind))
		return
	}
	if f.v2 == nil {
		return
	}
	kept := f.v2.Frames[:0]
	for _, fr := range f.v2.Frames {
		if _, ok := fr.(*id3v2.PictureFrame); ok {
			continue
		}
		kept = append(kept, fr)
	}
	f.v2.Frames = kept
}

func (f *File) ensureMatroska() {
	if f.mkv == nil {
		f.mkv = &matroskaView{}
	}
}

func (f *File) addMatroskaImage(p Picture) {
	att := matroskaAttachmentFromPicture(p, len(f.mkv.Attachments))
	f.mkv.Attachments = append(f.mkv.Attachments, att)
	syncMatroskaPictures(f.mkv)
}

func (f *File) removeMatroskaImagesByType(pt PictureType) {
	if f.mkv == nil {
		return
	}
	kept := f.mkv.Attachments[:0]
	for _, att := range f.mkv.Attachments {
		mime := canonicalAttachmentMIME(att.MIME, att.Name, att.Data)
		if mime != "" && pictureTypeFromAttachment(att) == pt {
			continue
		}
		kept = append(kept, att)
	}
	f.mkv.Attachments = kept
	syncMatroskaPictures(f.mkv)
}

func retainMatroskaNonImageAttachments(in []Attachment) []Attachment {
	out := in[:0]
	for _, att := range in {
		if canonicalAttachmentMIME(att.MIME, att.Name, att.Data) != "" {
			continue
		}
		out = append(out, att)
	}
	return out
}

func syncMatroskaPictures(view *matroskaView) {
	if view == nil {
		return
	}
	view.Pictures = view.Pictures[:0]
	for _, att := range view.Attachments {
		if mime := canonicalAttachmentMIME(att.MIME, att.Name, att.Data); mime != "" {
			view.Pictures = append(view.Pictures, Picture{
				MIME:        mime,
				Type:        pictureTypeFromAttachment(att),
				Description: att.Description,
				Data:        att.Data,
			})
		}
	}
}

func matroskaAttachmentFromPicture(p Picture, idx int) Attachment {
	mime := strings.TrimSpace(p.MIME)
	if mime == "" {
		mime = guessImageMIME("", p.Data)
	}
	ext := "bin"
	switch strings.ToLower(mime) {
	case "image/jpeg", "image/jpg":
		ext = "jpg"
	case "image/png":
		ext = "png"
	case "image/gif":
		ext = "gif"
	case "image/bmp":
		ext = "bmp"
	case "image/webp":
		ext = "webp"
	}
	base := "picture"
	switch p.Type {
	case PictureCoverFront:
		base = "cover-front"
	case PictureCoverBack:
		base = "cover-back"
	}
	name := fmt.Sprintf("%s-%d.%s", base, idx+1, ext)
	if p.Type == PictureCoverFront || p.Type == PictureCoverBack {
		name = fmt.Sprintf("%s.%s", base, ext)
	}
	return Attachment{
		Name:        name,
		Description: p.Description,
		MIME:        mime,
		Data:        append([]byte(nil), p.Data...),
	}
}
