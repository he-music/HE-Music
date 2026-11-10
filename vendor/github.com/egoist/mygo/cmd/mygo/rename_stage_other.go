//go:build !windows

package main

import "os"

// renamePackageStage moves a built package's stage to where the package
// goes.
func renamePackageStage(from, to string) error {
	return os.Rename(from, to)
}
