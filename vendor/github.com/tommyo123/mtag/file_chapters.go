package mtag

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

// SetChapters replaces the current chapter set for containers with a
// native writable chapter store.
func (f *File) SetChapters(chapters []Chapter) error {
	if !supportsChapterMutation(f.Container()) {
		return fmt.Errorf("%w: %s cannot write chapters", ErrUnsupportedOperation, f.Container())
	}
	f.chapters = cloneChapters(chapters)
	f.chaptersDirty = true
	return nil
}

// RemoveChapters removes every native chapter entry from the current file state.
func (f *File) RemoveChapters() error {
	return f.SetChapters(nil)
}

func supportsChapterMutation(kind ContainerKind) bool {
	switch {
	case kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerMatroska || kind == ContainerWAV:
		return true
	case supportsWritableID3v2(kind):
		return true
	}
	return false
}

func cloneChapters(in []Chapter) []Chapter {
	if len(in) == 0 {
		return nil
	}
	out := make([]Chapter, len(in))
	for i, ch := range in {
		out[i] = Chapter{
			ID:        ch.ID,
			Start:     ch.Start,
			End:       ch.End,
			Title:     ch.Title,
			Subtitle:  ch.Subtitle,
			URL:       ch.URL,
			ImageMIME: ch.ImageMIME,
		}
		if len(ch.Image) > 0 {
			out[i].Image = append([]byte(nil), ch.Image...)
		}
	}
	return out
}

func (f *File) chapterSnapshot() []Chapter {
	if !f.chaptersDirty {
		return nil
	}
	return cloneChapters(f.chapters)
}

func (f *File) applyChapterOverride() error {
	if !f.chaptersDirty {
		return nil
	}
	switch kind := f.Container(); {
	case kind == ContainerFLAC || kind == ContainerOGG:
		return f.applyVorbisChapterOverride()
	case kind == ContainerMP4, kind == ContainerMatroska, kind == ContainerWAV:
		return nil
	case supportsWritableID3v2(kind):
		return f.applyID3ChapterOverride()
	default:
		return fmt.Errorf("%w: %s cannot write chapters", ErrUnsupportedOperation, kind)
	}
}

func (f *File) applyID3ChapterOverride() error {
	if len(f.chapters) > 0 {
		f.ensureV2()
	}
	if f.v2 == nil {
		return nil
	}
	f.v2.Remove(id3v2.FrameChapter)
	f.v2.Remove(id3v2.FrameTOC)
	if len(f.chapters) == 0 {
		f.v2.InvalidateIndex()
		return nil
	}
	childIDs := make([]string, 0, len(f.chapters))
	for i, ch := range f.chapters {
		id := strings.TrimSpace(ch.ID)
		if id == "" {
			id = fmt.Sprintf("ch%03d", i+1)
		}
		childIDs = append(childIDs, id)
		frame := &id3v2.ChapterFrame{
			ElementID:   id,
			StartTimeMs: uint32(maxDuration(ch.Start, 0) / time.Millisecond),
			EndTimeMs:   uint32(maxDuration(ch.End, ch.Start) / time.Millisecond),
			StartOffset: 0xFFFFFFFF,
			EndOffset:   0xFFFFFFFF,
		}
		if ch.Title != "" {
			frame.SubFrames = append(frame.SubFrames, &id3v2.TextFrame{
				FrameID: id3v2.FrameTitle,
				Values:  []string{ch.Title},
			})
		}
		if ch.Subtitle != "" {
			frame.SubFrames = append(frame.SubFrames, &id3v2.TextFrame{
				FrameID: id3v2.FrameSubtitle,
				Values:  []string{ch.Subtitle},
			})
		}
		if ch.URL != "" {
			frame.SubFrames = append(frame.SubFrames, &id3v2.UserURLFrame{URL: ch.URL})
		}
		if len(ch.Image) > 0 {
			frame.SubFrames = append(frame.SubFrames, &id3v2.PictureFrame{
				MIME:        ch.ImageMIME,
				PictureType: 0,
				Data:        append([]byte(nil), ch.Image...),
			})
		}
		f.v2.Frames = append(f.v2.Frames, frame)
	}
	f.v2.Frames = append(f.v2.Frames, &id3v2.TOCFrame{
		ElementID: "toc",
		TopLevel:  true,
		Ordered:   true,
		ChildIDs:  childIDs,
	})
	f.v2.InvalidateIndex()
	return nil
}

func (f *File) applyVorbisChapterOverride() error {
	if len(f.chapters) > 0 {
		f.ensureFLAC()
	}
	if f.flac == nil {
		return nil
	}
	if f.flac.comment == nil {
		f.flac.comment = &flac.VorbisComment{Vendor: "mtag"}
	}
	kept := f.flac.comment.Fields[:0]
	for _, field := range f.flac.comment.Fields {
		if _, _, ok := parseVorbisChapterField(field.Name); ok {
			continue
		}
		kept = append(kept, field)
	}
	f.flac.comment.Fields = kept
	for i, ch := range f.chapters {
		index := i + 1
		base := fmt.Sprintf("CHAPTER%03d", index)
		start := formatVorbisChapterTimestamp(ch.Start)
		if start == "" {
			start = "00:00:00.000"
		}
		f.flac.comment.Fields = append(f.flac.comment.Fields, flac.Field{Name: base, Value: start})
		if ch.Title != "" {
			f.flac.comment.Fields = append(f.flac.comment.Fields, flac.Field{Name: base + "NAME", Value: ch.Title})
		}
		if ch.URL != "" {
			f.flac.comment.Fields = append(f.flac.comment.Fields, flac.Field{Name: base + "URL", Value: ch.URL})
		}
	}
	return nil
}

func formatVorbisChapterTimestamp(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	h := d / time.Hour
	d -= h * time.Hour
	m := d / time.Minute
	d -= m * time.Minute
	s := d / time.Second
	d -= s * time.Second
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, d/time.Millisecond)
}

func maxDuration(v, floor time.Duration) time.Duration {
	if v < floor {
		return floor
	}
	return v
}

func chaptersForMP4(in []Chapter) []mp4.Chapter {
	if len(in) == 0 {
		return nil
	}
	out := make([]mp4.Chapter, 0, len(in))
	for i, ch := range in {
		id := strings.TrimSpace(ch.ID)
		if id == "" {
			id = strconv.Itoa(i + 1)
		}
		out = append(out, mp4.Chapter{
			Start: maxDuration(ch.Start, 0),
			End:   maxDuration(ch.End, ch.Start),
			Title: ch.Title,
		})
		_ = id
	}
	return out
}
