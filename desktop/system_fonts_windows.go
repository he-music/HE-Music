//go:build windows

package main

import (
	"errors"
	"sync"
	"syscall"
	"unsafe"
)

type logfontW struct {
	Height         int32
	Width          int32
	Escapement     int32
	Orientation    int32
	Weight         int32
	Italic         byte
	Underline      byte
	StrikeOut      byte
	CharSet        byte
	OutPrecision   byte
	ClipPrecision  byte
	Quality        byte
	PitchAndFamily byte
	FaceName       [32]uint16
}

type enumLogfontExW struct {
	LogFont  logfontW
	FullName [64]uint16
	Style    [32]uint16
	Script   [32]uint16
}

var (
	gdi32               = syscall.NewLazyDLL("gdi32.dll")
	user32              = syscall.NewLazyDLL("user32.dll")
	enumFontFamiliesExW = gdi32.NewProc("EnumFontFamiliesExW")
	getDC               = user32.NewProc("GetDC")
	releaseDC           = user32.NewProc("ReleaseDC")

	systemFontRouter = newSystemFontCollectorRouter()
	systemFontEnumMu sync.Mutex
	fontCallbackOnce sync.Once
	fontCallback     uintptr
)

func systemFontEnumCallback(font *enumLogfontExW, _ *uint32, _ uint32, opaqueID uintptr) uintptr {
	if font == nil {
		return 1
	}
	if systemFontRouter.collect(opaqueID, syscall.UTF16ToString(font.LogFont.FaceName[:])) {
		return 1
	}
	return 0
}

func systemFontCallback() uintptr {
	fontCallbackOnce.Do(func() {
		fontCallback = syscall.NewCallback(systemFontEnumCallback)
	})
	return fontCallback
}

func enumerateSystemFontFamilies() ([]string, error) {
	systemFontEnumMu.Lock()
	defer systemFontEnumMu.Unlock()

	dc, _, _ := getDC.Call(0)
	if dc == 0 {
		return nil, errors.New("GetDC failed")
	}
	defer releaseDC.Call(0, dc)

	collector := newSystemFontCollector()
	opaqueID := systemFontRouter.register(collector)
	defer systemFontRouter.unregister(opaqueID)

	var filter logfontW
	filter.CharSet = 1
	result, _, callErr := enumFontFamiliesExW.Call(dc, uintptr(unsafe.Pointer(&filter)), systemFontCallback(), opaqueID, 0)
	if result == 0 && !collector.stopped && callErr != syscall.Errno(0) {
		return nil, callErr
	}
	return collector.families, nil
}
