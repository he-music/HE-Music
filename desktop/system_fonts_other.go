//go:build !darwin && !windows && !linux

package main

func enumerateSystemFontFamilies() ([]string, error) {
	return nil, errSystemFontsUnsupported
}
