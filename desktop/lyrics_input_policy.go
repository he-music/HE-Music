package main

import "errors"

// GTK owns a copy of the region. An empty region ignores all pointer input;
// a nil region restores the widget's normal input area without clipping paint.
type nativeLyricsInputAccess struct {
	validWindow   func(uintptr) bool
	setShape      func(uintptr, uintptr)
	createRegion  func() uintptr
	regionStatus  func(uintptr) int32
	destroyRegion func(uintptr)
}

func applyNativeLyricsInputShape(handle uintptr, ignored bool, access nativeLyricsInputAccess) error {
	if handle == 0 || access.validWindow == nil || access.setShape == nil || !access.validWindow(handle) {
		return errors.New("desktop lyrics native input window unavailable")
	}
	if !ignored {
		access.setShape(handle, 0)
		return nil
	}
	if access.createRegion == nil || access.regionStatus == nil || access.destroyRegion == nil {
		return errors.New("desktop lyrics native input region unavailable")
	}
	region := access.createRegion()
	if region == 0 {
		return errors.New("desktop lyrics native input region allocation failed")
	}
	defer access.destroyRegion(region)
	if access.regionStatus(region) != 0 {
		return errors.New("desktop lyrics native input region allocation failed")
	}
	access.setShape(handle, region)
	return nil
}
