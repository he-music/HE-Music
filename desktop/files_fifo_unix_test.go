//go:build !windows

package main

import (
	"errors"
	"syscall"
)

var errFileTestFIFOUnsupported = errors.New("FIFO fixture unavailable on this platform")

func makeFileTestFIFO(path string) error { return syscall.Mkfifo(path, 0o600) }
