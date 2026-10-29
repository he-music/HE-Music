//go:build !windows

package main

import (
	"errors"
	"os"
)

// downloadCommitDirectoryDurability syncs the containing directory on platforms
// that expose directory Sync. A successful result means the fresh ref may be
// reported with durable=true.
func downloadCommitDirectoryDurability(root *os.Root) (durable bool, err error) {
	directory, err := root.Open(".")
	if err != nil {
		return false, err
	}
	err = errors.Join(directory.Sync(), directory.Close())
	return err == nil, err
}
