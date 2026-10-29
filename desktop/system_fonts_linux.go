//go:build linux

package main

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	fontconfigRTLDNow     = 0x2
	fontconfigResultMatch = 0
	fontconfigSystemSet   = 0
)

type fontconfigBindings struct {
	once        sync.Once
	err         error
	config      func() uintptr
	configFonts func(uintptr, int32) *fontconfigFontSet
	getString   func(*fontconfigPattern, *byte, int32, **byte) int32
	init        func() int32
}

var cachedFontconfig fontconfigBindings

func (b *fontconfigBindings) initialize() {
	b.once.Do(func() {
		library, err := purego.Dlopen("libfontconfig.so.1", fontconfigRTLDNow)
		if err != nil {
			library, err = purego.Dlopen("libfontconfig.so", fontconfigRTLDNow)
		}
		if err != nil {
			b.err = err
			return
		}
		purego.RegisterLibFunc(&b.config, library, "FcConfigGetCurrent")
		purego.RegisterLibFunc(&b.configFonts, library, "FcConfigGetFonts")
		purego.RegisterLibFunc(&b.getString, library, "FcPatternGetString")
		purego.RegisterLibFunc(&b.init, library, "FcInit")
		if b.init() == 0 {
			b.err = errors.New("fontconfig initialization failed")
		}
	})
}

func enumerateSystemFontFamilies() ([]string, error) {
	cachedFontconfig.initialize()
	if cachedFontconfig.err != nil {
		return nil, cachedFontconfig.err
	}
	fontSet := cachedFontconfig.configFonts(cachedFontconfig.config(), fontconfigSystemSet)
	if fontSet == nil {
		return nil, errors.New("fontconfig returned no system font set")
	}

	set := fontSet
	if set.nfont < 0 || set.nfont > maxSystemFontScan {
		return nil, errors.New("fontconfig returned an invalid font count")
	}
	collector := newSystemFontCollector()
	familyKey := []byte("family\x00")
	for _, pattern := range unsafe.Slice(set.fonts, int(set.nfont)) {
		if pattern == nil || !collector.collect(fontconfigFamily(pattern, familyKey)) {
			break
		}
	}
	return collector.families, nil
}

type fontconfigFontSet struct {
	nfont int32
	sfont int32
	fonts **fontconfigPattern
}

type fontconfigPattern struct{}

func fontconfigFamily(pattern *fontconfigPattern, key []byte) string {
	var value *byte
	if cachedFontconfig.getString(pattern, &key[0], 0, &value) != fontconfigResultMatch {
		return ""
	}
	return boundedFontconfigString(value)
}

func boundedFontconfigString(value *byte) string {
	if value == nil {
		return ""
	}
	for length := 0; length <= maxSystemFontName; length++ {
		if *(*byte)(unsafe.Add(unsafe.Pointer(value), length)) == 0 {
			return string(unsafe.Slice(value, length))
		}
	}
	return ""
}
