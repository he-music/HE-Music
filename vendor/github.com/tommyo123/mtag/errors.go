package mtag

import "errors"

// Error values returned by the mtag package. Use errors.Is to test
// them so that wrapped errors are matched correctly.
var (
	// ErrNoTag is returned when a caller asks for a tag that isn't
	// present in the file.
	ErrNoTag = errors.New("mtag: no tag present")
	// ErrUnsupportedFormat indicates a file whose bytes do not match any
	// format mtag knows how to parse safely.
	ErrUnsupportedFormat = errors.New("mtag: unsupported file format")
	// ErrUnsupportedOperation indicates that the requested mutation is
	// not meaningful for the current container or API surface.
	ErrUnsupportedOperation = errors.New("mtag: unsupported operation")
	// ErrInvalidTag indicates a tag whose bytes do not conform to
	// the format specification.
	ErrInvalidTag = errors.New("mtag: invalid tag")
	// ErrUnsupportedVersion is returned for tag versions that we do
	// not (yet) understand.
	ErrUnsupportedVersion = errors.New("mtag: unsupported tag version")
	// ErrReadOnly is returned from mutating calls on a file opened
	// read-only.
	ErrReadOnly = errors.New("mtag: file is read-only")
	// ErrFileTooLarge is returned when an open guard rejects the
	// source size before parsing starts.
	ErrFileTooLarge = errors.New("mtag: file exceeds configured size limit")
)
