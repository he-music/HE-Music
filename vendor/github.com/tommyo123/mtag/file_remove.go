package mtag

import (
	"fmt"

	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
)

// FieldKey identifies one of the common polymorphic fields exposed by
// getters and setters on [File].
type FieldKey uint8

const (
	FieldTitle FieldKey = iota + 1
	FieldArtist
	FieldAlbum
	FieldAlbumArtist
	FieldComposer
	FieldYear
	FieldTrack
	FieldDisc
	FieldGenre
	FieldComment
	FieldLyrics
	FieldCompilation
	FieldCopyright
	FieldPublisher
	FieldEncodedBy
)

// String renders a stable lower-case label for logs and diagnostics.
func (k FieldKey) String() string {
	switch k {
	case FieldTitle:
		return "title"
	case FieldArtist:
		return "artist"
	case FieldAlbum:
		return "album"
	case FieldAlbumArtist:
		return "album-artist"
	case FieldComposer:
		return "composer"
	case FieldYear:
		return "year"
	case FieldTrack:
		return "track"
	case FieldDisc:
		return "disc"
	case FieldGenre:
		return "genre"
	case FieldComment:
		return "comment"
	case FieldLyrics:
		return "lyrics"
	case FieldCompilation:
		return "compilation"
	case FieldCopyright:
		return "copyright"
	case FieldPublisher:
		return "publisher"
	case FieldEncodedBy:
		return "encoded-by"
	}
	return "unknown"
}

// RemoveField removes one common mapped field from the active metadata
// stores. Custom fields keep using [File.RemoveCustom].
func (f *File) RemoveField(key FieldKey) error {
	switch key {
	case FieldTitle:
		f.removeMappedTextField(fieldTitle, func(v *id3v1.Tag) { v.Title = "" }, nil)
	case FieldArtist:
		f.removeMappedTextField(fieldArtist, func(v *id3v1.Tag) { v.Artist = "" }, nil)
	case FieldAlbum:
		f.removeMappedTextField(fieldAlbum, func(v *id3v1.Tag) { v.Album = "" }, nil)
	case FieldAlbumArtist:
		f.removeAlbumArtistField()
	case FieldComposer:
		f.removeMappedTextField(fieldComposer, nil, nil)
	case FieldYear:
		f.removeYearField()
	case FieldTrack:
		f.removeTrackField()
	case FieldDisc:
		f.removeDiscField()
	case FieldGenre:
		f.removeGenreField()
	case FieldComment:
		f.removeCommentField()
	case FieldLyrics:
		f.removeLyricsField()
	case FieldCompilation:
		f.removeCompilationField()
	case FieldCopyright:
		f.removeMappedTextField(fieldCopyright, nil, nil)
	case FieldPublisher:
		f.removeMappedTextField(fieldPublisher, nil, nil)
	case FieldEncodedBy:
		f.removeMappedTextField(fieldEncodedBy, nil, nil)
	default:
		return fmt.Errorf("%w: unknown field %d", ErrUnsupportedOperation, key)
	}
	return nil
}

// RemoveTag removes one native tag store from the file state. Save
// persists the change back to disk.
func (f *File) RemoveTag(kind TagKind) error {
	container := f.Container()
	switch kind {
	case TagID3v1:
		if f.v1 == nil {
			return ErrNoTag
		}
		f.v1 = nil
		f.formats &^= FormatID3v1
		return nil

	case TagID3v2:
		if f.v2 == nil && f.v2size == 0 {
			return ErrNoTag
		}
		if !supportsWritableID3v2(container) {
			return unsupportedTagOperation(container, kind)
		}
		f.v2 = nil
		f.formats &^= FormatID3v2Any
		return nil

	case TagVorbis:
		switch container {
		case ContainerFLAC:
			if f.flac == nil || f.flac.comment == nil {
				return ErrNoTag
			}
			f.flac.comment = nil
			return nil
		case ContainerOGG:
			if f.flac == nil || f.flac.comment == nil {
				return ErrNoTag
			}
			f.flac = &flacView{comment: nil}
			return nil
		default:
			return unsupportedTagOperation(container, kind)
		}

	case TagMP4:
		if container != ContainerMP4 {
			return unsupportedTagOperation(container, kind)
		}
		if f.mp4 == nil {
			return ErrNoTag
		}
		f.mp4 = nil
		return nil

	case TagMatroska:
		if container != ContainerMatroska {
			return unsupportedTagOperation(container, kind)
		}
		if f.mkv == nil || len(f.mkv.Fields) == 0 {
			return ErrNoTag
		}
		f.mkv = &matroskaView{
			Attachments: append([]Attachment(nil), f.mkv.Attachments...),
			Pictures:    append([]Picture(nil), f.mkv.Pictures...),
			Chapters:    append([]Chapter(nil), f.mkv.Chapters...),
		}
		return nil

	case TagTracker:
		if !isTrackerContainer(container) {
			return unsupportedTagOperation(container, kind)
		}
		if f.tracker == nil {
			return ErrNoTag
		}
		f.tracker.Fields = nil
		return nil

	case TagAPE:
		if !isAPEContainer(container) && !supportsRawAPETail(container) {
			return unsupportedTagOperation(container, kind)
		}
		if f.ape == nil && f.apeLen == 0 {
			return ErrNoTag
		}
		f.ape = nil
		return nil

	case TagRIFFInfo:
		if !isWaveContainer(container) {
			return unsupportedTagOperation(container, kind)
		}
		if f.riffInfo == nil {
			return ErrNoTag
		}
		f.riffInfo = &riffInfoView{
			kind:   container,
			values: map[string]string{},
			dirty:  true,
		}
		return nil

	case TagAIFFText:
		if container != ContainerAIFF {
			return unsupportedTagOperation(container, kind)
		}
		if f.riffInfo == nil {
			return ErrNoTag
		}
		f.riffInfo = &riffInfoView{
			kind:   ContainerAIFF,
			values: map[string]string{},
			dirty:  true,
		}
		return nil

	case TagBWF:
		if container != ContainerWAV {
			return unsupportedTagOperation(container, kind)
		}
		if f.bwf == nil || f.bwf.empty() {
			return ErrNoTag
		}
		f.bwf = &bwfView{dirty: true}
		return nil

	case TagASF:
		if container != ContainerASF {
			return unsupportedTagOperation(container, kind)
		}
		if f.asf == nil {
			return ErrNoTag
		}
		f.asf = &asfView{}
		return nil

	case TagRealMedia:
		if container != ContainerRealMedia {
			return unsupportedTagOperation(container, kind)
		}
		if f.realMedia == nil {
			return ErrNoTag
		}
		f.realMedia = nil
		return nil

	case TagCAF:
		if container != ContainerCAF {
			return unsupportedTagOperation(container, kind)
		}
		if f.caf == nil {
			return ErrNoTag
		}
		f.caf = &cafView{
			values:    map[string]string{},
			dirty:     true,
			chunkAt:   f.caf.chunkAt,
			chunkSize: f.caf.chunkSize,
		}
		return nil
	}
	return unsupportedTagOperation(container, kind)
}

func unsupportedTagOperation(container ContainerKind, kind TagKind) error {
	return fmt.Errorf("%w: %s cannot remove %s", ErrUnsupportedOperation, container, kind)
}

func (f *File) removeMappedTextField(field commonField, clearV1 func(*id3v1.Tag), removeID3 func(*id3v2.Tag)) {
	spec := fieldSpec(field)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case isTrackerContainer(kind):
		if f.tracker != nil {
			setMappedPrimary(f.tracker, spec.tracker, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetFrameText(spec.id3, "")
		}
		return
	case kind == ContainerCAF:
		if f.caf != nil {
			setMappedPrimary(f.caf, spec.caf, "")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	case kind == ContainerRealMedia:
		if f.realMedia != nil {
			setMappedPrimary(f.realMedia, spec.realMedia, "")
		}
		return
	}
	if f.v2 != nil {
		if removeID3 != nil {
			removeID3(f.v2)
		} else if spec.id3 != "" {
			f.v2.Remove(spec.id3)
		}
	}
	if f.v1 != nil && clearV1 != nil {
		clearV1(f.v1)
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(spec.id3, kind); key != "" {
			f.riffInfo.Set(key, "")
		}
	}
}

func (f *File) removeAlbumArtistField() {
	spec := fieldSpec(fieldAlbumArtist)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetFrameText(spec.id3, "")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(spec.id3)
		for _, name := range spec.vorbis {
			f.removeUserText(name)
		}
	}
}

func (f *File) removeYearField() {
	spec := fieldSpec(fieldYear)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetFrameText("TDRC", "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	}
	if f.v2 != nil {
		for _, id := range yearFramePriority {
			f.v2.Remove(id)
		}
	}
	if f.v1 != nil {
		f.v1.Year = ""
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(spec.id3, kind); key != "" {
			f.riffInfo.Set(key, "")
		}
	}
}

func (f *File) removeTrackField() {
	spec := fieldSpec(fieldTrack)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			f.flac.comment.Set("TRACKNUMBER", "")
			f.flac.comment.Set("TRACKTOTAL", "")
			f.flac.comment.Set("TOTALTRACKS", "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4RemoveName("trkn")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(id3v2.FrameTrack)
	}
	if f.v1 != nil {
		f.v1.Track = 0
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(spec.id3, kind); key != "" {
			f.riffInfo.Set(key, "")
		}
	}
}

func (f *File) removeDiscField() {
	spec := fieldSpec(fieldDisc)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			f.flac.comment.Set("DISCNUMBER", "")
			f.flac.comment.Set("DISCTOTAL", "")
			f.flac.comment.Set("TOTALDISCS", "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4RemoveName("disk")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(id3v2.FramePart)
	}
}

func (f *File) removeGenreField() {
	spec := fieldSpec(fieldGenre)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetText("\xa9gen", "")
			f.mp4RemoveName("gnre")
			f.mp4SyncMDTA(mp4MDTAKeysForFrame(id3v2.FrameGenre), "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(id3v2.FrameGenre)
	}
	if f.v1 != nil {
		f.v1.Genre = 255
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(spec.id3, kind); key != "" {
			f.riffInfo.Set(key, "")
		}
	}
}

func (f *File) removeCommentField() {
	spec := fieldSpec(fieldComment)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetFrameText(id3v2.FrameComment, "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case isTrackerContainer(kind):
		if f.tracker != nil {
			setMappedPrimary(f.tracker, spec.tracker, "")
		}
		return
	case kind == ContainerASF:
		if f.asf != nil {
			setMappedPrimary(f.asf, spec.asf, "")
		}
		return
	case kind == ContainerRealMedia:
		if f.realMedia != nil {
			setMappedPrimary(f.realMedia, spec.realMedia, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(id3v2.FrameComment)
	}
	if f.v1 != nil {
		f.v1.Comment = ""
	}
	if f.riffInfo != nil && (isWaveContainer(kind) || kind == ContainerAIFF) {
		if key := riffInfoKeyFor(spec.id3, kind); key != "" {
			f.riffInfo.Set(key, "")
		}
	}
}

func (f *File) removeLyricsField() {
	spec := fieldSpec(fieldLyrics)
	kind := f.Container()
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG:
		if f.flac != nil && f.flac.comment != nil {
			setMappedPrimary(f.flac.comment, spec.vorbis, "")
		}
		return
	case isAPEContainer(kind):
		if f.ape != nil {
			setMappedPrimary(f.ape, spec.ape, "")
		}
		return
	case kind == ContainerMatroska:
		if f.mkv != nil {
			setMappedPrimary(f.mkv, spec.matroska, "")
		}
		return
	case kind == ContainerMP4:
		if f.mp4 != nil {
			f.mp4SetFrameText(id3v2.FrameLyrics, "")
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove(id3v2.FrameLyrics)
	}
}

func (f *File) removeCompilationField() {
	if f.Container() == ContainerMP4 {
		if f.mp4 != nil {
			f.mp4SetCompilation(false)
		}
		return
	}
	if f.v2 != nil {
		f.v2.Remove("TCMP")
	}
}
