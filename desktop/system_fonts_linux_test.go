//go:build linux

package main

import (
	"strings"
	"testing"
	"unsafe"
)

func TestEnumerateSystemFontFamiliesLinux(t *testing.T) {
	fonts, err := enumerateSystemFonts()
	if err != nil {
		t.Fatal(err)
	}
	if len(fonts) == 0 {
		t.Fatal("fontconfig returned no system font families")
	}
	if len(fonts) > maxSystemFontCount {
		t.Fatalf("fontconfig returned %d families, limit is %d", len(fonts), maxSystemFontCount)
	}
	for _, font := range fonts {
		if font.Family == "" {
			t.Fatal("fontconfig returned an empty family")
		}
	}
}

func TestBoundedFontconfigString(t *testing.T) {
	for _, test := range []struct {
		name  string
		bytes []byte
		want  string
	}{
		{name: "511 bytes", bytes: append([]byte(strings.Repeat("a", maxSystemFontName-1)), 0), want: strings.Repeat("a", maxSystemFontName-1)},
		{name: "512 bytes", bytes: append([]byte(strings.Repeat("b", maxSystemFontName)), 0), want: strings.Repeat("b", maxSystemFontName)},
		{name: "513 bytes", bytes: append([]byte(strings.Repeat("c", maxSystemFontName+1)), 0), want: ""},
		{name: "unterminated", bytes: []byte(strings.Repeat("d", maxSystemFontName+1)), want: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := boundedFontconfigString((*byte)(unsafe.Pointer(&test.bytes[0])))
			if got != test.want {
				t.Fatalf("got length %d, want length %d", len(got), len(test.want))
			}
		})
	}
}
