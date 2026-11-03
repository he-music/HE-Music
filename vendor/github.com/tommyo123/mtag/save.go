package mtag

import (
	"context"
	"errors"
	"fmt"

	"github.com/tommyo123/mtag/id3v1"
)

// defaultPadding is the amount of zero-byte padding written at the
// end of a freshly created or grown ID3v2 tag. This gives room for
// future edits without forcing another full rewrite.
const defaultPadding = 1024

// SaveContext is the cancellable variant of [File.Save]. The
// context is checked at each major step of the rewrite (encode,
// chunk-by-chunk audio copy, rename) so a grow-rewrite on a very
// large file can be aborted without partially corrupting the
// original — the temp file is discarded on cancellation and the
// original is left untouched.
func (f *File) SaveContext(ctx context.Context) error {
	f.saveCtx = ctx
	defer func() { f.saveCtx = nil }()
	return f.Save()
}

// Save persists every tag present in f back to disk. When both
// ID3v1 and ID3v2 are present, the v2 tag is the source of truth
// and the v1 values are re-derived from it so the two stay in sync.
//
// For WAV and AIFF containers Save rebuilds the file by walking
// every chunk in order, replacing (or adding, or dropping) the
// `id3 ` chunk, and recomputing the outer RIFF/FORM size. The
// rewrite goes to a sibling temp file and is atomically renamed
// over the original.
//
// Files opened via [OpenSource] or [OpenBytes] do not carry a
// writable handle; Save on those returns [ErrReadOnly].
func (f *File) Save() error {
	if f.forceReadOnly || (f.fd == nil && f.rw == nil) {
		return ErrReadOnly
	}
	if f.container == nil {
		return errors.New("mtag: file is not initialized")
	}
	if err := f.checkCtx(); err != nil {
		return err
	}
	if err := f.applyChapterOverride(); err != nil {
		return err
	}
	modTime := f.pathModTime()
	if err := f.container.saveMetadata(f); err != nil {
		return err
	}
	f.applyPathModTime(f.path, modTime)
	return f.refreshAfterSave()
}

func (f *File) saveExactFormats(want Format) error {
	if err := validateWriteFormat(want); err != nil {
		return err
	}
	if want.HasAny(FormatID3v2Any) && f.v2 == nil {
		f.ensureV2()
	}
	if want.Has(FormatID3v1) && f.v1 == nil {
		f.v1 = &id3v1.Tag{Genre: 255}
	}
	switch {
	case want.Has(FormatID3v24):
		if f.v2 != nil {
			f.v2.Version = 4
		}
	case want.Has(FormatID3v23):
		if f.v2 != nil {
			f.v2.Version = 3
		}
	case want.Has(FormatID3v22):
		if f.v2 != nil {
			f.v2.Version = 2
		}
	}
	// Sync v1 from v2 before dropping v2 so the v1 footer reflects
	// any setter writes that only landed on v2.
	if want.Has(FormatID3v1) && !want.HasAny(FormatID3v2Any) && f.v2 != nil && f.v1 != nil {
		_ = f.syncV1FromV2()
	}
	if !want.HasAny(FormatID3v2Any) {
		f.v2 = nil
	}
	if !want.Has(FormatID3v1) {
		f.v1 = nil
	}
	f.formats = want & (FormatID3v1 | FormatID3v2Any)
	return f.Save()
}

// validateWriteFormat checks that want describes a realistic
// on-disk configuration: at most one ID3v2 major version, plus an
// optional ID3v1 footer.
func validateWriteFormat(want Format) error {
	// Count the ID3v2 version bits.
	v2Bits := want & FormatID3v2Any
	n := 0
	for _, bit := range []Format{FormatID3v22, FormatID3v23, FormatID3v24} {
		if v2Bits&bit != 0 {
			n++
		}
	}
	if n > 1 {
		return fmt.Errorf("mtag: SaveFormats needs at most one ID3v2 version, got %s", want)
	}
	// Reject bits we do not know about.
	const known = FormatID3v1 | FormatID3v2Any
	if want & ^known != 0 {
		return fmt.Errorf("mtag: SaveFormats: unknown format bits in %s", want)
	}
	return nil
}

// SaveFormats persists the file using exactly the requested on-disk
// tag-format set.
func (f *File) SaveFormats(want Format) error {
	return f.saveExactFormats(want)
}

// Deprecated: use [File.SaveFormats].
//
// SaveWith is the compatibility alias of [File.SaveFormats].
func (f *File) SaveWith(want Format) error {
	return f.saveExactFormats(want)
}
