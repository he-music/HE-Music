//go:build !darwin && !linux && !windows

package main

import (
	"errors"
	"os"
)

func metadataCheckAttributes(*os.File) error {
	return errors.New("metadata attribute preservation is unavailable on this platform")
}
func metadataCopyAttributes(*os.File, *os.File) error {
	return errors.New("metadata attribute preservation is unavailable on this platform")
}
