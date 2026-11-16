package rpm

import (
	"fmt"
	"io"
)

// cpio.go implements the SVR4 "newc" cpio writer used for the RPM payload. We own
// it (rather than depend on an external cpio package) so the output is fully
// deterministic, ghost files are handled cleanly, content can be streamed, and
// there is no extra dependency. Every entry is:
//
//	110 bytes  ASCII header: "070701" + 13 fields of 8 uppercase hex digits
//	namesize   the file name + a trailing NUL
//	pad        zero bytes to a 4-byte boundary (measured from the start of the
//	           header, i.e. over 110 + namesize)
//	filesize   the file body
//	pad        zero bytes to a 4-byte boundary over the body
//
// The archive ends with a "TRAILER!!!" entry that has no body.

const cpioMagic = "070701"

const cpioTrailerName = "TRAILER!!!"

// cpioMaxFileSize is the largest content size representable in a newc header
// (c_filesize is 8 hex digits).
const cpioMaxFileSize = 0xffffffff

type cpioWriter struct {
	w       io.Writer
	written int64 // total uncompressed bytes emitted (the archive size)
}

func newCPIOWriter(w io.Writer) *cpioWriter {
	return &cpioWriter{w: w}
}

func cpioPad(n int64) int64 {
	return (4 - n%4) % 4
}

// Write implements io.Writer so content can be streamed straight into the
// archive (and counted) via io.Copy.
func (c *cpioWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.written += int64(n)
	if err != nil {
		return n, fmt.Errorf("rpm: writing cpio payload: %w", err)
	}
	return n, nil
}

// writeEntry writes one cpio record, streaming size bytes from content. name
// should already be in its on-disk form (RPM uses a "./"-relative path). content
// is nil for directories (size 0) and a reader over the link target for symlinks.
func (c *cpioWriter) writeEntry(name string, mode, mtime uint32, ino, nlink int, size int64, content io.Reader) error {
	if size > cpioMaxFileSize {
		return fmt.Errorf("rpm: file %q is %d bytes; newc cpio payload supports at most %d", name, size, int64(cpioMaxFileSize))
	}
	nameSize := len(name) + 1 // include trailing NUL
	hdr := fmt.Sprintf("%s%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X",
		cpioMagic,
		ino,      // c_ino
		mode,     // c_mode
		0,        // c_uid
		0,        // c_gid
		nlink,    // c_nlink
		mtime,    // c_mtime
		size,     // c_filesize
		0,        // c_devmajor
		0,        // c_devminor
		0,        // c_rdevmajor
		0,        // c_rdevminor
		nameSize, // c_namesize
		0,        // c_check (unused for 070701)
	)
	if _, err := io.WriteString(c, hdr); err != nil {
		return err
	}
	if _, err := io.WriteString(c, name); err != nil {
		return err
	}
	if _, err := c.Write([]byte{0}); err != nil {
		return err
	}
	if err := c.writePad(cpioPad(int64(len(hdr) + nameSize))); err != nil {
		return err
	}
	if content != nil && size > 0 {
		n, err := io.Copy(c, content)
		if err != nil {
			return fmt.Errorf("rpm: streaming %q: %w", name, err)
		}
		if n != size {
			return fmt.Errorf("rpm: file %q: streamed %d bytes, expected %d (did the source change?)", name, n, size)
		}
	}
	return c.writePad(cpioPad(size))
}

// close writes the trailer record.
func (c *cpioWriter) close() error {
	return c.writeEntry(cpioTrailerName, 0, 0, 0, 1, 0, nil)
}

func (c *cpioWriter) writePad(n int64) error {
	if n == 0 {
		return nil
	}
	_, err := c.Write(make([]byte, n))
	return err
}
