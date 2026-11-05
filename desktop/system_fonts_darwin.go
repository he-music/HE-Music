//go:build darwin

package main

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	rtldNow      = 0x2
	utf8Encoding = 0x08000100
)

type coreTextBindings struct {
	once       sync.Once
	err        error
	copyNames  func() uintptr
	arrayCount func(uintptr) int64
	arrayValue func(uintptr, int64) uintptr
	stringGet  func(uintptr, *byte, int64, uint32) bool
	release    func(uintptr)
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
		purego.RegisterLibFunc(&b.copyNames, coreText, "CTFontManagerCopyAvailableFontFamilyNames")
		purego.RegisterLibFunc(&b.arrayCount, coreFoundation, "CFArrayGetCount")
		purego.RegisterLibFunc(&b.arrayValue, coreFoundation, "CFArrayGetValueAtIndex")
		purego.RegisterLibFunc(&b.stringGet, coreFoundation, "CFStringGetCString")
		purego.RegisterLibFunc(&b.release, coreFoundation, "CFRelease")
	})
}

func enumerateSystemFontFamilies() ([]string, error) {
	cachedCoreText.initialize()
	if cachedCoreText.err != nil {
		return nil, cachedCoreText.err
	}
	array := cachedCoreText.copyNames()
	if array == 0 {
		return nil, errors.New("CoreText returned no font family array")
	}
	defer cachedCoreText.release(array)
	count := cachedCoreText.arrayCount(array)
	if count < 0 || count > maxSystemFontCount*4 {
		return nil, errors.New("CoreText returned an invalid font family count")
	}
	fonts := make([]string, 0, boundedMin(int(count), maxSystemFontCount))
	for i := range count {
		value := cachedCoreText.arrayValue(array, i)
		if value == 0 {
			continue
		}
		buffer := make([]byte, maxSystemFontName+1)
		if cachedCoreText.stringGet(value, &buffer[0], int64(len(buffer)), utf8Encoding) {
			length := 0
			for length < len(buffer) && buffer[length] != 0 {
				length++
			}
			fonts = append(fonts, string(unsafe.Slice(&buffer[0], length)))
		}
	}
	return fonts, nil
}
