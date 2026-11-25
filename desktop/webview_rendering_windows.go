package main

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func configureNativeLyricsRendering(handle uintptr) error {
	const (
		windows11Build        = 22000
		dwmwaCornerPreference = 33
		dwmwaBorderColor      = 34
		dwmwcpDoNotRound      = 1
		dwmColorNone          = 0xFFFFFFFE
	)
	if _, _, build := windows.RtlGetNtVersionNumbers(); build < windows11Build {
		return nil
	}

	// mygo requests rounded corners for Panel windows even with DisableShadow.
	// Override those decorations without changing the window's resize or input styles.
	hwnd := windows.HWND(handle)
	var result error
	for _, setting := range [...]struct{ attribute, value uint32 }{
		{dwmwaCornerPreference, dwmwcpDoNotRound},
		{dwmwaBorderColor, dwmColorNone},
	} {
		size := uint32(unsafe.Sizeof(setting.value))
		if err := windows.DwmSetWindowAttribute(hwnd, setting.attribute, unsafe.Pointer(&setting.value), size); err != nil {
			result = errors.Join(result, fmt.Errorf("设置桌面歌词 DWM 属性 %d: %w", setting.attribute, err))
		}
	}
	return result
}
