//go:build !windows

package main

import (
	"errors"
	"os"
)

// metadataCommitDirectoryDurability reports whether the directory Sync completed.
// All I/O errors, including Close failures, remain visible to the caller.
func metadataCommitDirectoryDurability(root *os.Root) (bool, error) {
	directory, err := root.Open(".")
	if err != nil {
		return false, err
	}
	err = errors.Join(directory.Sync(), directory.Close())
	return err == nil, err
}
