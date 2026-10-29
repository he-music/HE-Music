//go:build windows

package main

import "os"

// Windows does not provide a supported directory fsync through os.Root. The
// commit remains published and must register a fresh ref, while the caller
// exposes durable=false as durability_uncertain.
func downloadCommitDirectoryDurability(root *os.Root) (durable bool, err error) {
	info, err := root.Stat(".")
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, os.ErrInvalid
	}
	return false, nil
}
