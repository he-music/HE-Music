package mtag

import (
	"io"

	"github.com/tommyo123/mtag/id3v2"
)

// OMA / ATRAC files (Sony OpenMG Audio: .oma, .aa3, .omg, .at3) carry
// an ID3v2 tag whose first three bytes read "ea3" instead of "ID3".
// Reads wrap the source with a shim that substitutes the magic so the
// standard id3v2 parser can decode the tag; saves re-patch the bytes
// back to "ea3" after writing.
const omaMagic = "ea3"

// omaReader is a read-only wrapper around another [io.ReaderAt] that
// rewrites the first three bytes of the file from "ea3" to "ID3"
// on every read so the id3v2 parser sees a valid ID3v2 header.
type omaReader struct {
	r io.ReaderAt
}

func (o omaReader) ReadAt(p []byte, off int64) (int, error) {
	n, err := o.r.ReadAt(p, off)
	if n <= 0 || off >= 3 {
		return n, err
	}
	// Only the bytes overlapping [0..3) need substitution.
	end := int64(n)
	if off+end > 3 {
		end = 3 - off
	}
	patched := [3]byte{'I', 'D', '3'}
	for i := int64(0); i < end; i++ {
		p[i] = patched[off+i]
	}
	return n, err
}

// detectOMA reads the ID3v2-compatible tag at offset 0 through the
// magic-substituting shim.
func (f *File) detectOMA() error {
	tag, err := id3v2.ReadBounded(omaReader{r: f.src}, 0, f.size)
	if err != nil {
		return nil // no parseable tag; leave f.v2 nil
	}
	f.v2 = tag
	f.v2at = 0
	f.v2size = tag.OriginalSize
	return nil
}

// saveOMA rewrites or patches the OMA metadata block, then restores
// the "ea3" magic. The body format is identical to ID3v2, so we
// reuse [saveMP3] (which handles in-place vs. grow rewrites and
// audio shifts) and patch the three magic bytes afterwards.
func (f *File) saveOMA() error {
	if err := f.saveMP3(); err != nil {
		return err
	}
	// Only patch the magic when a tag actually landed at offset 0.
	if f.v2 == nil || f.v2size == 0 {
		return nil
	}
	w, err := f.writable()
	if err != nil {
		return err
	}
	_, err = w.WriteAt([]byte(omaMagic), 0)
	return err
}
