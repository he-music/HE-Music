package rpm

import (
	"compress/gzip"
	"io"
	"strconv"

	"github.com/klauspost/compress/zstd"
	"github.com/ulikunitz/xz"
	"github.com/ulikunitz/xz/lzma"
)

// Compressor selects the RPM payload compression. The default (gzip level 9) uses
// only the standard library; xz, lzma, and zstd pull in small pure-Go libraries.
// The method set is unexported so callers configure a compressor through the
// factory functions and hold the result, but cannot supply a foreign
// implementation (the encoder relies on these producing rpm-compatible streams).
type Compressor interface {
	// name is the RPMTAG_PAYLOADCOMPRESSOR value (e.g. "gzip").
	name() string
	// flags is the RPMTAG_PAYLOADFLAGS value (typically the level).
	flags() string
	// newWriter wraps w in a compressing WriteCloser.
	newWriter(w io.Writer) (io.WriteCloser, error)
}

// GzipCompressor compresses the payload with gzip at the given level (0-9, or
// gzip.DefaultCompression). This is the default and is dependency-free.
func GzipCompressor(level int) Compressor { return gzipCompressor{level: level} }

// XzCompressor compresses the payload with xz.
func XzCompressor() Compressor { return xzCompressor{} }

// LzmaCompressor compresses the payload with lzma.
func LzmaCompressor() Compressor { return lzmaCompressor{} }

// ZstdCompressor compresses the payload with zstd at the given level (e.g. 3, 19).
func ZstdCompressor(level int) Compressor { return zstdCompressor{level: level} }

// defaultCompressor is gzip level 9, matching rpmpack's default.
func defaultCompressor() Compressor { return GzipCompressor(gzip.BestCompression) }

type gzipCompressor struct{ level int }

func (g gzipCompressor) name() string { return "gzip" }
func (g gzipCompressor) flags() string {
	if g.level < 0 {
		return "9"
	}
	return strconv.Itoa(g.level)
}
func (g gzipCompressor) newWriter(w io.Writer) (io.WriteCloser, error) {
	return gzip.NewWriterLevel(w, g.level)
}

type xzCompressor struct{}

func (xzCompressor) name() string  { return "xz" }
func (xzCompressor) flags() string { return "6" }
func (xzCompressor) newWriter(w io.Writer) (io.WriteCloser, error) {
	return xz.NewWriter(w)
}

type lzmaCompressor struct{}

func (lzmaCompressor) name() string  { return "lzma" }
func (lzmaCompressor) flags() string { return "9" }
func (lzmaCompressor) newWriter(w io.Writer) (io.WriteCloser, error) {
	return lzma.NewWriter(w)
}

type zstdCompressor struct{ level int }

func (z zstdCompressor) name() string  { return "zstd" }
func (z zstdCompressor) flags() string { return strconv.Itoa(z.level) }
func (z zstdCompressor) newWriter(w io.Writer) (io.WriteCloser, error) {
	return zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(z.level)))
}
