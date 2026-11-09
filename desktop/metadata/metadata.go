// Package metadata adapts the pinned mtag implementation without opening paths.
// Callers own authorization, source handles, working copies and final replacement.
package metadata

import (
	"context"
	"errors"
	"io"

	"github.com/tommyo123/mtag"
	"github.com/tommyo123/mtag/id3v2"
)

// UpstreamCommit identifies the implementation validated by this adapter.
const UpstreamCommit = "57fea0d75b4f88edcdee8ca75e9423d522023f86"

var ErrUnsupportedContainer = errors.New("metadata: unsupported container")

// Picture preserves the native image role and description as well as its bytes.
type Picture struct {
	MIME        string
	Type        byte
	Description string
	Data        []byte
}

// Info keeps performers separate from album artists. Zero audio properties mean
// unknown or not applicable; no lossless classification is inferred from suffixes.
type Info struct {
	Container       string
	Title           string
	Artists         []string
	Album           string
	AlbumArtists    []string
	Comment         string
	Lyrics          string
	Pictures        []Picture
	PicturesLoaded  bool
	DurationSeconds float64
	BitrateKbps     float64
	SampleRateHz    int
	Channels        int
	BitsPerSample   int
	Codec           string
}

// Patch uses nil to preserve a field, and a pointer to an empty value to clear
// it. Pictures, when supplied, replaces all pictures (the editor's existing
// behavior). Comment maps the editor alias; no duplicate description is invented.
type Patch struct {
	Title        *string
	Artists      *[]string
	Album        *string
	AlbumArtists *[]string
	Comment      *string
	Lyrics       *string
	Pictures     *[]Picture
}

// WorkingCopy is deliberately pathless. It must refer to a private copy, never
// the authorized original. A failed edit makes the copy disposable; callers must
// not replace the original until independent validation and identity checks pass.
type WorkingCopy interface {
	io.ReaderAt
	io.WriterAt
	Truncate(int64) error
}

// ParseScan is read-only and skips image/attachment payloads.
func ParseScan(src io.ReaderAt, size int64) (Info, error) {
	return parse(src, size, false)
}

// Parse reads a complete editor view without granting write access.
func Parse(src io.ReaderAt, size int64) (Info, error) {
	return parse(src, size, true)
}

func parse(src io.ReaderAt, size int64, pictures bool) (Info, error) {
	opts := []mtag.OpenOption{mtag.WithReadOnly()}
	if !pictures {
		opts = append(opts, mtag.WithSkipPictures(), mtag.WithSkipAttachments())
	}
	f, err := mtag.OpenSource(src, size, opts...)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	if err := supported(f); err != nil {
		return Info{}, err
	}
	audio := f.AudioProperties()
	info := Info{
		Container: f.Container().String(), Title: f.Title(), Album: f.Album(),
		Artists: artistValues(f, false), AlbumArtists: artistValues(f, true),
		Comment: f.Comment(), Lyrics: f.Lyrics(), PicturesLoaded: pictures,
		DurationSeconds: audio.Duration.Seconds(), BitrateKbps: float64(audio.Bitrate) / 1000,
		SampleRateHz: audio.SampleRate, Channels: audio.Channels,
		BitsPerSample: audio.BitDepth, Codec: audio.Codec,
	}
	if info.Container == "dff" {
		if layout, err := inspectDFF(payloadSource{ctx: context.Background(), r: src, size: size}); err == nil {
			info.Codec = layout.codec
			info.BitsPerSample = 1
			info.DurationSeconds = layout.duration
			info.BitrateKbps = float64(layout.mediaSize) * 8 / layout.duration / 1000
		}
	}
	if pictures {
		for _, p := range f.Images() {
			info.Pictures = append(info.Pictures, Picture{p.MIME, byte(p.Type), p.Description, p.Data})
		}
	}
	return info, nil
}

func supported(f *mtag.File) error {
	if f.Container() == mtag.ContainerUnknown {
		return ErrUnsupportedContainer
	}
	return nil
}

func artistValues(f *mtag.File, album bool) []string {
	frame, key, fallback := id3v2.FrameArtist, "ARTIST", f.Artist()
	if album {
		frame, key, fallback = id3v2.FrameBand, "ALBUMARTIST", f.AlbumArtist()
	}
	if f.Container() == mtag.ContainerFLAC || f.Container() == mtag.ContainerOGG {
		if values := f.CustomValues(key); len(values) > 0 {
			return append([]string(nil), values...)
		}
		if album {
			if values := f.CustomValues("ALBUM ARTIST"); len(values) > 0 {
				return append([]string(nil), values...)
			}
		}
	} else if tag := f.ID3v2(); tag != nil {
		var values []string
		for _, frame := range tag.FindAll(frame) {
			if text, ok := frame.(*id3v2.TextFrame); ok {
				values = append(values, text.Values...)
			}
		}
		if len(values) > 0 {
			return values
		}
	}
	if fallback != "" {
		return []string{fallback}
	}
	return nil
}

func setArtists(f *mtag.File, values []string, album bool) {
	frame, key := id3v2.FrameArtist, "ARTIST"
	if album {
		frame, key = id3v2.FrameBand, "ALBUMARTIST"
	}
	if f.Container() == mtag.ContainerFLAC || f.Container() == mtag.ContainerOGG {
		if album {
			f.RemoveCustom("ALBUM ARTIST")
		}
		f.SetCustomValues(key, values...)
		return
	}
	first := ""
	if len(values) > 0 {
		first = values[0]
	}
	// The convenience setter creates ID3v2 and updates a legacy v1 primary
	// value. The actual v2 field is then written with every native value.
	if album {
		f.SetAlbumArtist(first)
	} else {
		f.SetArtist(first)
	}
	if tag := f.ID3v2(); tag != nil {
		tag.SetText(frame, values...)
	}
}

// EditWorkingCopy fully reopens metadata; scan views can never be saved. The
// caller retains handle ownership. Save may use OS staging files internally.
func EditWorkingCopy(ctx context.Context, src WorkingCopy, size int64, patch Patch) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if src == nil || size <= 0 {
		return ErrInvalidPayload
	}
	return editPreservingTrailer(ctx, src, size, patch)
}

func editWorkingCopy(ctx context.Context, src WorkingCopy, size int64, patch Patch) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f, err := mtag.OpenWritableSource(src, size, mtag.WithCreateV2OnV1Only(), mtag.WithSyncV1toV2())
	if err != nil {
		return err
	}
	defer f.Close()
	if err := supported(f); err != nil {
		return err
	}
	if patch.Title != nil {
		f.SetTitle(*patch.Title)
	}
	if patch.Artists != nil {
		setArtists(f, *patch.Artists, false)
	}
	if patch.Album != nil {
		f.SetAlbum(*patch.Album)
	}
	if patch.AlbumArtists != nil {
		setArtists(f, *patch.AlbumArtists, true)
	}
	if patch.Comment != nil {
		f.SetComment(*patch.Comment)
	}
	if patch.Lyrics != nil {
		f.SetLyrics(*patch.Lyrics)
	}
	if patch.Pictures != nil {
		f.RemoveImages()
		for _, p := range *patch.Pictures {
			f.AddImage(mtag.Picture{MIME: p.MIME, Type: mtag.PictureType(p.Type), Description: p.Description, Data: p.Data})
		}
	}
	if err := errors.Join(f.Errs()...); err != nil {
		return err
	}
	return f.SaveContext(ctx)
}
