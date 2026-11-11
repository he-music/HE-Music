//go:build !darwin && !windows && !linux

package main

import "errors"

var errSystemFontsUnsupported = errors.New("system font enumeration is unsupported on this platform")

func enumerateSystemFonts() ([]SystemFont, error) {
	return nil, errSystemFontsUnsupported
}
