package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/he-music/HE-Music/desktop/metadata"
)

const displayImageLimit = 4 << 20
const displayLyricsLimit = 1 << 20
const displayReadBudget = 16 << 20

// Display reads are transient. They never compute or expose an editor SHA baseline.
// The process-wide bound also covers overlapping windows and cancelled callers
// until their actual reads finish.
var localDisplaySlots = make(chan struct{}, 4)

type displayReader struct {
	ctx       context.Context
	source    io.ReaderAt
	mu        sync.Mutex
	remaining int64
}

func (r *displayReader) ReadAt(p []byte, off int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	r.mu.Lock()
	if int64(len(p)) > r.remaining {
		r.mu.Unlock()
		return 0, errMetadataLimit
	}
	r.remaining -= int64(len(p))
	r.mu.Unlock()
	return r.source.ReadAt(p, off)
}

// ReadLocalArtwork accepts only a registered audio capability. The .jpg name is
// derived below its granted Root; the renderer cannot supply a sidecar pathname.
// Embedded JPEG/PNG wins; malformed tags still permit a valid same-name .jpg.
func (f *NativeFiles) ReadLocalArtwork(ctx context.Context, epoch uint64, ref LocalFileRef) MetadataResult {
	return f.readLocalDisplay(ctx, epoch, ref, true)
}

// ReadLocalLyrics prefers same-name UTF-8 .lrc, then bounded embedded lyrics.
func (f *NativeFiles) ReadLocalLyrics(ctx context.Context, epoch uint64, ref LocalFileRef) MetadataResult {
	return f.readLocalDisplay(ctx, epoch, ref, false)
}

func (f *NativeFiles) readLocalDisplay(ctx context.Context, epoch uint64, ref LocalFileRef, artwork bool) MetadataResult {
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer lease.Release()
	op, cancel := context.WithTimeout(lease.Context(), 8*time.Second)
	defer cancel()
	select {
	case localDisplaySlots <- struct{}{}:
		defer func() { <-localDisplaySlots }()
	case <-op.Done():
		return MetadataResult{Code: metadataCode(op.Err())}
	}
	source, err := f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer source.Close()
	before, err := source.Stat()
	if err != nil {
		return MetadataResult{Code: "io_error"}
	}
	unlock, err := metadataCoordinatorFor(&f.state).lock(op, before)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer unlock()
	// Re-resolve after waiting for an editor or another display reader.
	check := func() error {
		if err := op.Err(); err != nil {
			return err
		}
		current, err := f.state.resolveLocalFile(lease, ref)
		if err != nil {
			return err
		}
		defer current.Close()
		now, err := current.Stat()
		if err != nil {
			return err
		}
		if !sameLocalFileInfo(before, now) {
			return errFilesChanged
		}
		return f.state.checkLease(lease)
	}
	if err := check(); err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	info := metadata.Info{PicturesLoaded: artwork}
	sidecar := func(extension string, limit int64) ([]byte, error) {
		name := ref.RelativePath[:len(ref.RelativePath)-len(path.Ext(ref.RelativePath))] + extension
		return readDisplaySidecar(op, lease, name, limit)
	}
	parse := func() (metadata.Info, error) {
		reader := &displayReader{ctx: op, source: source, remaining: displayReadBudget}
		if artwork {
			return metadata.Parse(reader, before.Size())
		}
		return metadata.ParseScan(reader, before.Size())
	}
	if artwork {
		parsed, _ := parse()
		for _, front := range []bool{true, false} {
			for i, picture := range parsed.Pictures {
				if i >= 32 {
					break
				}
				if (picture.Type == 3) == front && displayPicture(picture) {
					info.Pictures = []metadata.Picture{{MIME: picture.MIME, Type: picture.Type, Data: picture.Data}}
					break
				}
			}
			if len(info.Pictures) != 0 {
				break
			}
		}
		if len(info.Pictures) == 0 && op.Err() == nil {
			data, sideErr := sidecar(".jpg", displayImageLimit)
			_, format, _ := image.DecodeConfig(bytes.NewReader(data))
			picture := metadata.Picture{MIME: "image/" + format, Type: 3, Data: data}
			if sideErr == nil && displayPicture(picture) {
				info.Pictures = []metadata.Picture{{MIME: picture.MIME, Type: picture.Type, Data: picture.Data}}
			}
		}
	} else {
		data, sideErr := sidecar(".lrc", displayLyricsLimit)
		if sideErr == nil && len(data) != 0 && utf8.Valid(data) {
			info.Lyrics = string(data)
		}
		if info.Lyrics == "" && op.Err() == nil {
			parsed, parseErr := parse()
			if parseErr == nil && len(parsed.Lyrics) <= displayLyricsLimit && utf8.ValidString(parsed.Lyrics) {
				info.Lyrics = parsed.Lyrics
			}
		}
	}
	after, statErr := source.Stat()
	if statErr != nil || !sameLocalFileInfo(before, after) {
		return MetadataResult{Code: "conflict"}
	}
	if err := check(); err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	return MetadataResult{Code: "ok", Ref: &ref, Info: &info}
}

func displayPicture(picture metadata.Picture) bool {
	if len(picture.Data) == 0 || len(picture.Data) > displayImageLimit {
		return false
	}
	if picture.MIME != "image/jpeg" && picture.MIME != "image/png" {
		return false
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(picture.Data))
	if err != nil || "image/"+format != picture.MIME {
		return false
	}
	return config.Width > 0 && config.Height > 0 && config.Width <= 4096 && config.Height <= 4096 && int64(config.Width)*int64(config.Height) <= 16000000
}

func readDisplaySidecar(ctx context.Context, lease *directoryLease, name string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	source, before, parent, err := openGrantedRegularInfo(lease, name)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	if before.Size() <= 0 || before.Size() > limit {
		return nil, errMetadataLimit
	}
	reader := &displayReader{ctx: ctx, source: source, remaining: limit}
	data := make([]byte, before.Size())
	n, err := reader.ReadAt(data, 0)
	if n != len(data) || (err != nil && !errors.Is(err, io.EOF)) {
		return nil, io.ErrUnexpectedEOF
	}
	after, err := source.Stat()
	if err != nil || !sameLocalFileInfo(before, after) {
		return nil, errFilesChanged
	}
	current, final, finalParent, err := openGrantedRegularInfo(lease, name)
	if err != nil {
		return nil, err
	}
	current.Close()
	if !sameLocalFileInfo(before, final) || !os.SameFile(parent, finalParent) {
		return nil, errFilesChanged
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return data, nil
}
