package mtag

import (
	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
)

// checkCtx reports whether the active save context has been cancelled.
func (f *File) checkCtx() error {
	if f.saveCtx == nil {
		return nil
	}
	return f.saveCtx.Err()
}

// Container returns the detected container kind.
func (f *File) Container() ContainerKind {
	if f.container == nil {
		return ContainerUnknown
	}
	return f.container.Kind()
}

// Close releases the underlying file handle and all cached metadata.
func (f *File) Close() error {
	if f == nil {
		return nil
	}
	var err error
	if f.fd != nil {
		err = f.fd.Close()
	}
	f.clearSourceHandles()
	f.clearDetectedState()
	f.errs = nil
	f.chapters = nil
	return err
}

// Path returns the path the file was opened from.
func (f *File) Path() string { return f.path }

// Writable reports whether the file has read/write access.
func (f *File) Writable() bool {
	return f.openedRW && (f.fd != nil || f.rw != nil)
}

// Formats returns the detected ID3 format bitmask.
func (f *File) Formats() Format { return f.formats }

// Err returns the first recorded recoverable setter error.
func (f *File) Err() error {
	if len(f.errs) == 0 {
		return nil
	}
	return f.errs[0]
}

// Errs returns every recorded recoverable setter error.
func (f *File) Errs() []error {
	if len(f.errs) == 0 {
		return nil
	}
	return append([]error(nil), f.errs...)
}

// ResetErr clears the recorded setter errors.
func (f *File) ResetErr() { f.errs = nil }

func (f *File) recordErr(err error) {
	if err == nil {
		return
	}
	f.errs = append(f.errs, err)
}

// ID3v1 returns the raw ID3v1 tag.
func (f *File) ID3v1() *id3v1.Tag { return f.v1 }

// Deprecated: use [File.ID3v1].
func (f *File) V1() *id3v1.Tag { return f.ID3v1() }

// ID3v2 returns the raw ID3v2 tag.
func (f *File) ID3v2() *id3v2.Tag { return f.v2 }

// Deprecated: use [File.ID3v2].
func (f *File) V2() *id3v2.Tag { return f.ID3v2() }

// APEv2 returns the raw APE tag.
func (f *File) APEv2() *ape.Tag { return f.ape }

// Deprecated: use [File.APEv2].
func (f *File) APE() *ape.Tag { return f.APEv2() }
