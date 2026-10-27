package main

import "errors"

var errFileTestFIFOUnsupported = errors.New("FIFO fixture unavailable on this platform")

func makeFileTestFIFO(string) error { return errFileTestFIFOUnsupported }
