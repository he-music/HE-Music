//go:build !darwin && !windows && !linux

package main

import "errors"

var errSystemFontsUnsupported = errors.New("system font enumeration is unsupported on this platform")

func enumerateSystemFontFamilies() ([]string, error) {
	return nil, errSystemFontsUnsupported
}
