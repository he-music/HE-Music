//go:build !windows

package mygo

import "os"

// readShared reads the file at path, which others may replace meanwhile.
func readShared(path string) ([]byte, error) { return os.ReadFile(path) }

// renameOver renames from over to.
func renameOver(from, to string) error { return os.Rename(from, to) }
