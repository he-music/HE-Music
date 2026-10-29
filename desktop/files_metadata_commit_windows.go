//go:build windows

package main

import (
	"os"
	"syscall"
)

// metadataCommitDirectoryDurability deliberately does not call FlushFileBuffers
// on a directory opened read-only by os.Root. Windows provides no ordinary-user
// directory fsync contract here. File Sync and os.Root.Rename remain mandatory
// in the caller, but do not establish power-loss durability for the rename.
//
// false, nil is an explicit platform limitation, not a swallowed I/O failure:
// the caller must report durability_uncertain, publish the fresh reference and
// retain the backup. Actual handle errors are returned separately.
func metadataCommitDirectoryDurability(root *os.Root) (bool, error) {
	info, err := root.Stat(".")
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, syscall.ENOTDIR
	}
	return false, nil
}
