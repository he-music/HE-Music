//go:build !darwin

package main

import (
	"errors"
	"os"
)

func metadataCheckAttributes(*os.File) error {
	return errors.New("metadata attribute preservation is supported only on macOS")
}
func metadataCopyAttributes(*os.File, *os.File) error {
	return errors.New("metadata attribute preservation is supported only on macOS")
}
