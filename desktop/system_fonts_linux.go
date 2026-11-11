//go:build linux

package main

import (
	"errors"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	fontconfigRTLDNow     = 0x2
	fontconfigResultMatch = 0
	fontconfigSystemSet   = 0

	fontconfigFamilyKey         = "family\x00"
	fontconfigFullNameKey       = "fullname\x00"
	fontconfigPostScriptNameKey = "postscriptname\x00"
	fontconfigStyleKey          = "style\x00"
	fontconfigWeightKey         = "weight\x00"
	fontconfigSlantKey          = "slant\x00"

	fontconfigSlantItalic  = 100
	fontconfigSlantOblique = 110
)

type fontconfigBindings struct {
	once        sync.Once
	err         error
	config      func() uintptr
	configFonts func(uintptr, int32) *fontconfigFontSet
	getString   func(*fontconfigPattern, *byte, int32, **byte) int32
	getInteger  func(*fontconfigPattern, *byte, int32, *int32) int32
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
		purego.RegisterLibFunc(&b.getInteger, library, "FcPatternGetInteger")
		purego.RegisterLibFunc(&b.init, library, "FcInit")
		if b.init() == 0 {
			b.err = errors.New("fontconfig initialization failed")
		}
	})
}

func enumerateSystemFonts() ([]SystemFont, error) {
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
	for _, pattern := range unsafe.Slice(set.fonts, int(set.nfont)) {
		if pattern == nil || !collector.collectFont(fontconfigFace(pattern)) {
			break
		}
	}
	return collector.fonts, nil
}

type fontconfigFontSet struct {
	nfont int32
	_     int32 // FcFontSet.sfont: retain the native ABI layout.
	fonts **fontconfigPattern
}

type fontconfigPattern struct{}

func fontconfigFace(pattern *fontconfigPattern) SystemFont {
	styleName := fontconfigString(pattern, fontconfigStyleKey)
	style := "normal"
	var slant int32
	if fontconfigInteger(pattern, fontconfigSlantKey, &slant) {
		switch slant {
		case fontconfigSlantItalic:
			style = "italic"
		case fontconfigSlantOblique:
			style = "oblique"
		}
	} else {
		lower := strings.ToLower(styleName)
		if strings.Contains(lower, "italic") {
			style = "italic"
		} else if strings.Contains(lower, "oblique") {
			style = "oblique"
		}
	}

	var nativeWeight int32
	weight := 400
	if fontconfigInteger(pattern, fontconfigWeightKey, &nativeWeight) {
		weight = fontconfigWeight(nativeWeight)
	}
	return SystemFont{
		Family:         fontconfigString(pattern, fontconfigFamilyKey),
		FullName:       fontconfigString(pattern, fontconfigFullNameKey),
		PostScriptName: fontconfigString(pattern, fontconfigPostScriptNameKey),
		Weight:         weight,
		Style:          style,
	}
}

func fontconfigString(pattern *fontconfigPattern, key string) string {
	keyBytes := []byte(key)
	var value *byte
	if cachedFontconfig.getString(pattern, &keyBytes[0], 0, &value) != fontconfigResultMatch {
		return ""
	}
	return boundedFontconfigString(value)
}

func fontconfigInteger(pattern *fontconfigPattern, key string, value *int32) bool {
	keyBytes := []byte(key)
	return cachedFontconfig.getInteger(pattern, &keyBytes[0], 0, value) == fontconfigResultMatch
}

func fontconfigWeight(weight int32) int {
	switch {
	case weight <= 0:
		return 100
	case weight <= 40:
		return 200
	case weight <= 55:
		return 300
	case weight <= 80:
		return 400
	case weight <= 100:
		return 500
	case weight <= 180:
		return 600
	case weight <= 200:
		return 700
	case weight <= 205:
		return 800
	default:
		return 900
	}
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
