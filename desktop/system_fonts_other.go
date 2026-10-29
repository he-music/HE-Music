//go:build !darwin && !windows

package main

func enumerateSystemFontFamilies() ([]string, error) {
	return nil, errSystemFontsUnsupported
}
