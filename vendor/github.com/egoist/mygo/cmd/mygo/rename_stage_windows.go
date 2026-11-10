//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// renamePackageStage moves a built package's stage to where the package
// goes. A virus scanner or an installer may still hold a file it just
// wrote, which fails the rename with ERROR_ACCESS_DENIED or
// ERROR_SHARING_VIOLATION until it lets go, so it is tried again for up
// to about a second. The same codes can mean a denial that lasts, which
// then fails as before, with the last error.
func renamePackageStage(from, to string) error {
	return retryPackageStageRename(func() error { return os.Rename(from, to) }, time.Sleep)
}

// retryPackageStageRename calls rename up to ten times, pausing 100 ms
// after each failure for a file in use.
func retryPackageStageRename(rename func() error, pause func(time.Duration)) error {
	const accessDenied, sharingViolation = syscall.Errno(5), syscall.Errno(32)
	for attempt := 1; ; attempt++ {
		err := rename()
		if err == nil || attempt == 10 || !errors.Is(err, accessDenied) && !errors.Is(err, sharingViolation) {
			return err
		}
		pause(100 * time.Millisecond)
	}
}
