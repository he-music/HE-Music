package mtag

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

type sourceState struct {
	path string
	fd   *os.File
	size int64

	src io.ReaderAt
	rw  WritableSource

	openedRW      bool
	forceReadOnly bool
}

type id3State struct {
	v1 *id3v1.Tag

	v2     *id3v2.Tag
	v2at   int64
	v2size int64

	v2corrupt bool
	formats   Format
}

type nativeState struct {
	container Container

	flac    *flacView
	oggErr  error
	mp4     *mp4View
	mkv     *matroskaView
	tracker *trackerView

	ape    *ape.Tag
	apeAt  int64
	apeLen int64

	riffInfo  *riffInfoView
	bwf       *bwfView
	asf       *asfView
	realMedia *realMediaView
	caf       *cafView
}

type policyState struct {
	createV2OnV1Only bool
	genreSync        GenreSyncStrategy
	paddingBudget    int64
	audioPropsStyle  AudioPropertiesStyle
}

type runtimeState struct {
	errs    []error
	saveCtx context.Context

	// audio is the cached result of AudioProperties() so repeated
	// calls don't re-read the codec headers. audioCached flips true
	// on first computation even when audio is still the zero value
	// (the format didn't expose any properties).
	audio       AudioProperties
	audioCached bool

	chapters      []Chapter
	chaptersDirty bool

	mpegReplayGain      mpegLameReplayGain
	mpegReplayGainDirty bool
}

// File is an audio file opened for metadata access. It is safe to
// query and mutate concurrently with other *File values, but a
// single *File must not be used from multiple goroutines without
// external synchronisation.
type File struct {
	sourceState
	id3State
	nativeState
	policyState
	runtimeState
}

// mp4View is the in-memory snapshot of the MP4 ilst items the
// polymorphic accessors care about. Items are returned by mp4.ReadItems
// in declaration order; we keep that order so multi-value tags
// round-trip when write support arrives.
type mp4View struct {
	items []mp4.Item
	mdta  []mp4.MDTAItem
}

// flacView is a small in-memory snapshot of the FLAC metadata
// blocks the polymorphic accessors care about. Unmodified blocks
// (STREAMINFO, SEEKTABLE, etc.) live in the file untouched.
type flacView struct {
	comment  *flac.VorbisComment
	pictures []*flac.Picture
}

// GenreSyncStrategy controls how syncV1FromV2 maps a free-form v2
// genre string onto the single ID3v1 genre byte.
type GenreSyncStrategy uint8

const (
	// GenreSyncRawText only accepts exact canonical ID3v1 names. A
	// free-form v2 genre that cannot be expressed in v1 leaves the
	// v1 genre unset and records a recoverable error.
	GenreSyncRawText GenreSyncStrategy = iota
	// GenreSyncNearestCanonical additionally normalises punctuation
	// and spacing before matching against the ID3v1 table, so values
	// like "Hip Hop" can land on the canonical "Hip-Hop" id.
	GenreSyncNearestCanonical
)

func (g GenreSyncStrategy) String() string {
	switch g {
	case GenreSyncRawText:
		return "raw-text"
	case GenreSyncNearestCanonical:
		return "nearest-canonical"
	}
	return "unknown"
}

// ensureV2 creates an empty ID3v2.4 tag when the active container uses
// ID3v2 as its writable store.
func (f *File) ensureV2() {
	if f.container == nil || !supportsWritableID3v2(f.container.Kind()) {
		return
	}
	if f.v2 != nil {
		return
	}
	f.v2 = id3v2.NewTag(4)
	f.formats |= FormatID3v24
	f.v2corrupt = false
}

func (f *File) ensureV2ForExclusiveField(field, value string) bool {
	if f.v2 != nil {
		return true
	}
	if f.container == nil || !supportsWritableID3v2(f.container.Kind()) {
		if value != "" {
			kind := ContainerKind(0)
			if f.container != nil {
				kind = f.container.Kind()
			}
			f.recordErr(fmt.Errorf("mtag: %s=%q dropped: %s has no writable ID3v2 store for this field", field, value, kind))
		}
		return false
	}
	if f.v1 == nil || f.createV2OnV1Only {
		f.ensureV2()
		return f.v2 != nil
	}
	if value != "" {
		f.recordErr(fmt.Errorf("mtag: %s=%q dropped: file has only ID3v1; use WithCreateV2OnV1Only or SaveWith(FormatID3v24) to promote it", field, value))
	}
	return false
}

// ensureFLAC creates an empty Vorbis Comment view for FLAC or OGG
// files when the first mutating accessor runs and the file has no
// existing comment block. The same `flacView` struct backs both
// containers because they share the Vorbis Comment wire format.
func (f *File) ensureFLAC() {
	if kind := f.Container(); kind != ContainerFLAC && kind != ContainerOGG {
		return
	}
	if f.flac == nil {
		f.flac = &flacView{}
	}
	f.oggErr = nil
	if f.flac.comment == nil {
		f.flac.comment = &flac.VorbisComment{Vendor: "mtag"}
	}
}

// ensureMP4 creates an empty ilst view for MP4 containers when the
// first mutating accessor runs and no metadata block was parsed.
func (f *File) ensureMP4() {
	if f.Container() != ContainerMP4 {
		return
	}
	if f.mp4 == nil {
		f.mp4 = &mp4View{}
	}
}

func (f *File) ensureRIFFInfo() {
	kind := f.Container()
	switch {
	case isWaveContainer(kind), kind == ContainerAIFF:
	default:
		return
	}
	if f.riffInfo == nil {
		f.riffInfo = &riffInfoView{
			kind:   kind,
			values: map[string]string{},
		}
	}
}

func isAPEContainer(kind ContainerKind) bool {
	switch kind {
	case ContainerMAC, ContainerWavPack, ContainerMPC, ContainerTAK:
		return true
	}
	return false
}

// ensureAPE creates an empty APEv2 tag for APE-native containers.
func (f *File) ensureAPE() {
	if !isAPEContainer(f.Container()) {
		return
	}
	if f.ape == nil {
		f.ape = ape.New()
	}
}
