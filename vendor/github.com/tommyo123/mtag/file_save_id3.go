package mtag

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/tommyo123/mtag/id3v1"
)

// saveMP3 is the mp3Container's save back-end: sync v1 from v2,
// then write the v2 region, then patch the v1 footer.
func (f *File) saveMP3() error {
	if err := f.syncV1FromV2(); err != nil {
		return err
	}
	if err := f.writeV2(); err != nil {
		return err
	}
	if f.ape != nil || f.apeLen > 0 {
		if err := f.saveRawAPETail(); err != nil {
			return err
		}
	}
	if err := f.writeV1(); err != nil {
		return err
	}
	return f.writeMPEGLameReplayGain()
}

// syncV1FromV2 copies the core fields from v2 into v1 when both are
// present, so the two formats stay consistent after an edit. v2 is
// the source of truth; there is no automatic sync in the other
// direction because v2 is strictly richer.
func (f *File) syncV1FromV2() error {
	if f.v1 == nil || f.v2 == nil {
		return nil
	}
	f.v1.Title = f.syncV1TextField("title", f.Title(), 30)
	f.v1.Artist = f.syncV1TextField("artist", f.Artist(), 30)
	f.v1.Album = f.syncV1TextField("album", f.Album(), 30)
	if y := f.Year(); y > 0 {
		f.v1.Year = fmt.Sprintf("%04d", y)
	} else {
		f.v1.Year = ""
	}

	track := f.Track()
	switch {
	case track >= 1 && track <= 255:
		f.v1.Track = byte(track)
		f.v1.Comment = f.syncV1TextField("comment", f.Comment(), 28)
	default:
		if track > 255 {
			f.recordErr(fmt.Errorf("mtag: id3v1 sync dropped track %d: ID3v1 supports at most 255", track))
		}
		f.v1.Track = 0
		f.v1.Comment = f.syncV1TextField("comment", f.Comment(), 30)
	}

	genre := f.Genre()
	if genre == "" {
		f.v1.Genre = 255
		return nil
	}
	if id, ok := f.genreIDForV1(genre); ok {
		f.v1.Genre = id
		return nil
	}
	f.v1.Genre = 255
	f.recordErr(fmt.Errorf("mtag: id3v1 sync dropped genre %q: no representable ID3v1 genre under %v strategy", genre, f.genreSync))
	return nil
}

// writeV2 serialises the ID3v2 tag and writes it back. If the tag
// is absent but a v2 tag was originally present, the existing tag
// on disk is stripped.
func (f *File) writeV2() error {
	if f.v2 == nil {
		if f.v2size == 0 {
			return nil
		}
		return f.rewriteWithV2(nil)
	}

	body, err := f.v2.Encode(0)
	if err != nil {
		return err
	}
	if int64(len(body)) <= f.v2size && f.v2size > 0 {
		pad := int(f.v2size - int64(len(body)))
		padded, err := f.v2.Encode(pad)
		if err != nil {
			return err
		}
		return f.patchAt(0, padded)
	}

	padded, err := f.v2.Encode(int(f.paddingBudgetOr(defaultPadding)))
	if err != nil {
		return err
	}
	return f.rewriteWithV2(padded)
}

// paddingBudgetOr returns the caller-requested padding budget when
// one was set via [WithPaddingBudget], or the given default.
func (f *File) paddingBudgetOr(def int64) int64 {
	if f.paddingBudget > 0 {
		return f.paddingBudget
	}
	return def
}

// writeV1 patches or appends the ID3v1 footer.
func (f *File) writeV1() error {
	if f.v1 == nil {
		if !f.formatsOnDisk().Has(FormatID3v1) {
			return nil
		}
		return f.truncateV1()
	}
	fd, err := f.writable()
	if err != nil {
		return err
	}
	newSize, err := f.v1.WriteAt(fd, f.size)
	if err != nil {
		return err
	}
	f.size = newSize
	return nil
}

// formatsOnDisk re-reads the end of the file to find out whether a
// v1 footer is still there.
func (f *File) formatsOnDisk() Format {
	var out Format
	if f.src != nil && f.size >= int64(id3v1.Size) {
		var head [3]byte
		if _, err := f.src.ReadAt(head[:], f.size-int64(id3v1.Size)); err == nil {
			if head == id3v1.Magic {
				out |= FormatID3v1
			}
		}
	}
	return out
}

func (f *File) truncateV1() error {
	fd, err := f.writable()
	if err != nil {
		return err
	}
	if err := fd.Truncate(f.size - int64(id3v1.Size)); err != nil {
		return err
	}
	f.size -= int64(id3v1.Size)
	return nil
}

// truncateLatin returns s trimmed to at most n bytes of ISO-8859-1
// representation. Characters outside Latin-1 are replaced with '?'.
func truncateLatin(s string, n int) string {
	out := make([]byte, 0, n)
	for _, r := range s {
		if len(out) >= n {
			break
		}
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	return string(out)
}

func (f *File) syncV1TextField(field, value string, limit int) string {
	out, truncated, substituted := truncateLatinWithReport(value, limit)
	switch {
	case truncated && substituted:
		f.recordErr(fmt.Errorf("mtag: id3v1 sync lossy for %s: text exceeded %d Latin-1 bytes and non-Latin-1 runes were replaced", field, limit))
	case truncated:
		f.recordErr(fmt.Errorf("mtag: id3v1 sync truncated %s to %d Latin-1 bytes", field, limit))
	case substituted:
		f.recordErr(fmt.Errorf("mtag: id3v1 sync replaced non-Latin-1 runes in %s", field))
	}
	return out
}

func truncateLatinWithReport(s string, n int) (out string, truncated bool, substituted bool) {
	buf := make([]byte, 0, n)
	for _, r := range s {
		if len(buf) >= n {
			truncated = true
			break
		}
		if r > 0xFF {
			substituted = true
			buf = append(buf, '?')
			continue
		}
		buf = append(buf, byte(r))
	}
	return string(buf), truncated, substituted
}

func (f *File) genreIDForV1(name string) (byte, bool) {
	if id := id3v1.GenreID(name); id != 255 {
		return id, true
	}
	if f.genreSync != GenreSyncNearestCanonical {
		return 255, false
	}
	want := normaliseGenreKey(name)
	if want == "" {
		return 255, false
	}
	for i, g := range id3v1.Genres {
		if normaliseGenreKey(g) == want {
			return byte(i), true
		}
	}
	return 255, false
}

func normaliseGenreKey(s string) string {
	var out []rune
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out = append(out, r)
		}
	}
	return string(out)
}
