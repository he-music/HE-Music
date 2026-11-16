package rpm

import "errors"

// Sentinel errors returned by Build.
var (
	// ErrNoName is returned when the package name is unset.
	ErrNoName = errors.New("rpm: package name is required")
	// ErrNoVersion is returned when the package version is unset.
	ErrNoVersion = errors.New("rpm: package version is required")
	// ErrGhostHasBody is returned when a ghost file is given a body; ghost files
	// are listed in the header but carry no payload.
	ErrGhostHasBody = errors.New("rpm: ghost file must not have a body")
	// ErrNoSpecFile is returned when building a source package without a spec.
	ErrNoSpecFile = errors.New("rpm: source package requires a spec file")
	// ErrNoSigningKey is returned when a signer is built without a private key.
	ErrNoSigningKey = errors.New("rpm: signer requires a private key")
)
