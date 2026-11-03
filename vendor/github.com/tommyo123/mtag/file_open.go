package mtag

import (
	"fmt"
	"io"
	"os"
)

// OpenOption tweaks how [Open] reads and prepares a file. Use the
// constructors to obtain values.
type OpenOption interface {
	apply(*openConfig)
}

type openConfig struct {
	readOnly         bool
	skipV1           bool
	skipV2           bool
	skipPictures     bool
	skipAttachments  bool
	syncV1toV2       bool
	createV2OnV1Only bool
	genreSync        GenreSyncStrategy
	leadingJunkScan  int64
	paddingBudget    int64
	maxFileSize      int64
	audioPropsStyle  AudioPropertiesStyle
}

type openOptionFunc func(*openConfig)

func (o openOptionFunc) apply(c *openConfig) { o(c) }

// WithReadOnly forces [Open] to use O_RDONLY.
func WithReadOnly() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.readOnly = true })
}

// WithSkipV1 skips the ID3v1 footer scan.
func WithSkipV1() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.skipV1 = true })
}

// WithSkipV2 skips all ID3v2 parsing.
func WithSkipV2() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.skipV2 = true })
}

// WithLeadingJunkScan lets MP3/AAC detection look past leading junk.
func WithLeadingJunkScan(maxBytes int64) OpenOption {
	return openOptionFunc(func(c *openConfig) { c.leadingJunkScan = maxBytes })
}

// WithSyncV1toV2 promotes a v1-only file to v2 on open.
func WithSyncV1toV2() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.syncV1toV2 = true })
}

// WithCreateV2OnV1Only lets v2-only setters promote a v1-only file.
func WithCreateV2OnV1Only() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.createV2OnV1Only = true })
}

// WithGenreSyncStrategy selects how v2 genre text maps back to ID3v1.
func WithGenreSyncStrategy(strategy GenreSyncStrategy) OpenOption {
	return openOptionFunc(func(c *openConfig) { c.genreSync = strategy })
}

// WithPaddingBudget sets the zero-padding emitted on grow rewrites.
func WithPaddingBudget(bytes int64) OpenOption {
	return openOptionFunc(func(c *openConfig) { c.paddingBudget = bytes })
}

// WithMaxFileSize rejects sources larger than maxBytes before parsing.
func WithMaxFileSize(maxBytes int64) OpenOption {
	return openOptionFunc(func(c *openConfig) { c.maxFileSize = maxBytes })
}

// WithAudioPropertiesStyle controls how aggressively
// [File.AudioProperties] scans raw audio streams.
//
// The default is [AudioPropertiesAccurate]. [AudioPropertiesFast]
// stays near the start of the stream, and [AudioPropertiesAverage]
// uses bounded scans where the format supports them.
func WithAudioPropertiesStyle(style AudioPropertiesStyle) OpenOption {
	return openOptionFunc(func(c *openConfig) { c.audioPropsStyle = style })
}

// WithSkipPictures drops every embedded picture immediately after
// parsing, so [File.Images] returns an empty list and the picture
// bytes don't linger in memory. Intended for batch scanning.
//
// Saving a file opened with this flag persists an empty picture set
// because the originals were never kept in memory. Combine with
// [WithReadOnly] when only scanning.
func WithSkipPictures() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.skipPictures = true })
}

// WithSkipAttachments drops native container attachments (currently
// Matroska / WebM) immediately after parsing. Same caveat as
// [WithSkipPictures]: a subsequent Save writes the file back with the
// attachment element dropped.
func WithSkipAttachments() OpenOption {
	return openOptionFunc(func(c *openConfig) { c.skipAttachments = true })
}

// WritableSource is the save-side abstraction used by
// [OpenWritableSource]. Rebuilt bytes are staged in a temp file and
// copied back through WriteAt and Truncate; the final replacement is
// not atomic.
type WritableSource interface {
	io.ReaderAt
	io.WriterAt
	Truncate(size int64) error
}

// OpenSource opens a read-only metadata view over a generic reader.
func OpenSource(src io.ReaderAt, size int64, opts ...OpenOption) (*File, error) {
	cfg := openConfig{readOnly: true}
	for _, o := range opts {
		o.apply(&cfg)
	}
	if err := checkOpenSizeLimit(size, cfg.maxFileSize); err != nil {
		return nil, err
	}
	f := &File{
		sourceState: sourceState{forceReadOnly: true},
		policyState: policyState{
			createV2OnV1Only: cfg.createV2OnV1Only,
			genreSync:        cfg.genreSync,
			paddingBudget:    cfg.paddingBudget,
			audioPropsStyle:  cfg.audioPropsStyle,
		},
	}
	f.attachReadOnlySource(src, size)
	if err := f.detectWith(cfg); err != nil {
		return nil, err
	}
	return f, nil
}

// OpenBytes opens a read-only metadata view over a byte slice.
func OpenBytes(data []byte, opts ...OpenOption) (*File, error) {
	return OpenSource(bytesReader(data), int64(len(data)), opts...)
}

// OpenWritableSource opens a read/write metadata view over a generic source.
func OpenWritableSource(src WritableSource, size int64, opts ...OpenOption) (*File, error) {
	cfg := openConfig{}
	for _, o := range opts {
		o.apply(&cfg)
	}
	if err := checkOpenSizeLimit(size, cfg.maxFileSize); err != nil {
		return nil, err
	}
	if cfg.readOnly {
		return OpenSource(src, size, opts...)
	}
	f := &File{
		policyState: policyState{
			createV2OnV1Only: cfg.createV2OnV1Only,
			genreSync:        cfg.genreSync,
			paddingBudget:    cfg.paddingBudget,
			audioPropsStyle:  cfg.audioPropsStyle,
		},
	}
	f.attachWritableSource(src, size)
	if err := f.detectWith(cfg); err != nil {
		return nil, err
	}
	return f, nil
}

// bytesReader is a minimal [io.ReaderAt] over a byte slice.
type bytesReader []byte

func (b bytesReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

// Open opens path for metadata access.
func Open(path string, opts ...OpenOption) (*File, error) {
	cfg := openConfig{}
	for _, o := range opts {
		o.apply(&cfg)
	}

	var fd *os.File
	var err error
	writable := false
	if cfg.readOnly {
		fd, err = os.Open(path)
	} else {
		fd, err = os.OpenFile(path, os.O_RDWR, 0)
		if err == nil {
			writable = true
		} else {
			ro, roErr := os.Open(path)
			if roErr != nil {
				return nil, err
			}
			fd = ro
		}
	}
	info, err := fd.Stat()
	if err != nil {
		_ = fd.Close()
		return nil, err
	}
	if err := checkOpenSizeLimit(info.Size(), cfg.maxFileSize); err != nil {
		_ = fd.Close()
		return nil, err
	}
	f := &File{
		sourceState: sourceState{forceReadOnly: cfg.readOnly},
		policyState: policyState{
			createV2OnV1Only: cfg.createV2OnV1Only,
			genreSync:        cfg.genreSync,
			paddingBudget:    cfg.paddingBudget,
			audioPropsStyle:  cfg.audioPropsStyle,
		},
	}
	f.attachPathHandle(path, fd, writable, info.Size())
	if err := f.detectWith(cfg); err != nil {
		_ = fd.Close()
		return nil, err
	}
	return f, nil
}

func checkOpenSizeLimit(size, max int64) error {
	if max > 0 && size > max {
		return fmt.Errorf("%w: %d > %d", ErrFileTooLarge, size, max)
	}
	return nil
}
