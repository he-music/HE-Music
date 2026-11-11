//go:build darwin

package main

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	rtldNow         = 0x2
	utf8Encoding    = 0x08000100
	cfNumberFloat64 = 6

	ctFontItalicTrait = 1 << 0
	ctFontBoldTrait   = 1 << 1
)

type coreTextBindings struct {
	once                sync.Once
	err                 error
	copyPostScriptNames func() uintptr
	createWithName      func(uintptr, float64, uintptr) uintptr
	copyFamilyName      func(uintptr) uintptr
	copyFullName        func(uintptr) uintptr
	copyPostScriptName  func(uintptr) uintptr
	getSymbolicTraits   func(uintptr) uint32
	copyTraits          func(uintptr) uintptr
	arrayCount          func(uintptr) int64
	arrayValue          func(uintptr, int64) uintptr
	stringGet           func(uintptr, *byte, int64, uint32) bool
	stringCreate        func(uintptr, *byte, uint32) uintptr
	dictionaryGetValue  func(uintptr, uintptr) uintptr
	numberGetValue      func(uintptr, int32, unsafe.Pointer) bool
	release             func(uintptr)
}

var cachedCoreText coreTextBindings

func (b *coreTextBindings) initialize() {
	b.once.Do(func() {
		coreText, err := purego.Dlopen("/System/Library/Frameworks/CoreText.framework/CoreText", rtldNow)
		if err != nil {
			b.err = err
			return
		}
		coreFoundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", rtldNow)
		if err != nil {
			_ = purego.Dlclose(coreText)
			b.err = err
			return
		}
		purego.RegisterLibFunc(&b.copyPostScriptNames, coreText, "CTFontManagerCopyAvailablePostScriptNames")
		purego.RegisterLibFunc(&b.createWithName, coreText, "CTFontCreateWithName")
		purego.RegisterLibFunc(&b.copyFamilyName, coreText, "CTFontCopyFamilyName")
		purego.RegisterLibFunc(&b.copyFullName, coreText, "CTFontCopyFullName")
		purego.RegisterLibFunc(&b.copyPostScriptName, coreText, "CTFontCopyPostScriptName")
		purego.RegisterLibFunc(&b.getSymbolicTraits, coreText, "CTFontGetSymbolicTraits")
		purego.RegisterLibFunc(&b.copyTraits, coreText, "CTFontCopyTraits")
		purego.RegisterLibFunc(&b.arrayCount, coreFoundation, "CFArrayGetCount")
		purego.RegisterLibFunc(&b.arrayValue, coreFoundation, "CFArrayGetValueAtIndex")
		purego.RegisterLibFunc(&b.stringGet, coreFoundation, "CFStringGetCString")
		purego.RegisterLibFunc(&b.stringCreate, coreFoundation, "CFStringCreateWithCString")
		purego.RegisterLibFunc(&b.dictionaryGetValue, coreFoundation, "CFDictionaryGetValue")
		purego.RegisterLibFunc(&b.numberGetValue, coreFoundation, "CFNumberGetValue")
		purego.RegisterLibFunc(&b.release, coreFoundation, "CFRelease")
	})
}

func enumerateSystemFonts() ([]SystemFont, error) {
	cachedCoreText.initialize()
	if cachedCoreText.err != nil {
		return nil, cachedCoreText.err
	}
	array := cachedCoreText.copyPostScriptNames()
	if array == 0 {
		return nil, errors.New("CoreText returned no PostScript font array")
	}
	defer cachedCoreText.release(array)
	count := cachedCoreText.arrayCount(array)
	if count < 0 || count > maxSystemFontScan {
		return nil, errors.New("CoreText returned an invalid PostScript font count")
	}

	collector := newSystemFontCollector()
	for i := range count {
		name := cachedCoreText.arrayValue(array, i)
		if name == 0 {
			continue
		}
		font := cachedCoreText.createWithName(name, 12, 0)
		if font == 0 {
			continue
		}
		face := SystemFont{
			Family:         coreTextString(cachedCoreText.copyFamilyName(font)),
			FullName:       coreTextString(cachedCoreText.copyFullName(font)),
			PostScriptName: coreTextString(cachedCoreText.copyPostScriptName(font)),
			Weight:         coreTextWeight(font),
			Style:          coreTextStyle(font),
		}
		cachedCoreText.release(font)
		if !collector.collectFont(face) {
			break
		}
	}
	return collector.fonts, nil
}

func coreTextString(value uintptr) string {
	if value == 0 {
		return ""
	}
	defer cachedCoreText.release(value)
	buffer := make([]byte, maxSystemFontName+1)
	if !cachedCoreText.stringGet(value, &buffer[0], int64(len(buffer)), utf8Encoding) {
		return ""
	}
	length := 0
	for length < len(buffer) && buffer[length] != 0 {
		length++
	}
	return string(buffer[:length])
}

func coreTextStyle(font uintptr) string {
	if cachedCoreText.getSymbolicTraits(font)&ctFontItalicTrait != 0 {
		return "italic"
	}
	return "normal"
}

func coreTextWeight(font uintptr) int {
	traits := cachedCoreText.copyTraits(font)
	if traits == 0 {
		if cachedCoreText.getSymbolicTraits(font)&ctFontBoldTrait != 0 {
			return 700
		}
		return 400
	}
	defer cachedCoreText.release(traits)

	keyBytes := []byte("NSCTFontWeightTrait\x00")
	key := cachedCoreText.stringCreate(0, &keyBytes[0], utf8Encoding)
	if key == 0 {
		return 400
	}
	defer cachedCoreText.release(key)
	value := cachedCoreText.dictionaryGetValue(traits, key)
	if value == 0 {
		return 400
	}
	var trait float64
	if !cachedCoreText.numberGetValue(value, cfNumberFloat64, unsafe.Pointer(&trait)) {
		return 400
	}
	return coreTextWeightValue(trait)
}

func coreTextWeightValue(value float64) int {
	switch {
	case value <= -0.8:
		return 100
	case value <= -0.55:
		return 200
	case value <= -0.25:
		return 300
	case value < 0.25:
		return 400
	case value < 0.5:
		return 500
	case value < 0.75:
		return 600
	case value < 0.9:
		return 700
	case value < 1.1:
		return 800
	default:
		return 900
	}
}
