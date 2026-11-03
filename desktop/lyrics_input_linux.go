//go:build linux

package main

import (
	"errors"
	"fmt"
	"sync"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

var linuxLyricsInput struct {
	sync.Once
	access nativeLyricsInputAccess
	err    error
}

func linuxNativeLyricsInput() (nativeLyricsInputAccess, error) {
	linuxLyricsInput.Do(func() {
		linuxLyricsInput.access, linuxLyricsInput.err = loadLinuxLyricsInput()
	})
	return linuxLyricsInput.access, linuxLyricsInput.err
}

func loadLinuxLyricsInput() (access nativeLyricsInputAccess, err error) {
	// Reuse the GTK ABI already loaded by mygo. No WebKit or SDK mutation is
	// needed: NativeHandle is the GtkWindow, whose input shape covers children.
	library, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_NOW|linuxPolicyRTLDNoLoad)
	if err != nil {
		return access, errors.New("desktop lyrics GTK input library unavailable")
	}
	defer func() {
		if failure := recover(); failure != nil {
			err = fmt.Errorf("desktop lyrics GTK input binding: %v", failure)
		}
		if err != nil {
			_ = purego.Dlclose(library)
			access = nativeLyricsInputAccess{}
		}
	}()
	var windowType func() uintptr
	var instanceIsA func(uintptr, uintptr) int32
	var getWindow func(uintptr) uintptr
	purego.RegisterLibFunc(&windowType, library, "gtk_window_get_type")
	purego.RegisterLibFunc(&instanceIsA, library, "g_type_check_instance_is_a")
	purego.RegisterLibFunc(&getWindow, library, "gtk_widget_get_window")
	purego.RegisterLibFunc(&access.setShape, library, "gtk_widget_input_shape_combine_region")
	purego.RegisterLibFunc(&access.createRegion, library, "cairo_region_create")
	purego.RegisterLibFunc(&access.regionStatus, library, "cairo_region_status")
	purego.RegisterLibFunc(&access.destroyRegion, library, "cairo_region_destroy")
	kind := windowType()
	access.validWindow = func(handle uintptr) bool {
		return instanceIsA(handle, kind) != 0 && getWindow(handle) != 0
	}
	return access, nil
}

func setLinuxLyricsInputShape(handle uintptr, ignored bool) error {
	access, err := linuxNativeLyricsInput()
	if err != nil {
		return err
	}
	return applyNativeLyricsInputShape(handle, ignored, access)
}

func setLyricsIgnoreMouseEvents(win *mygo.Window, ignored bool) error {
	if win == nil || win.IsDestroyed() {
		return errors.New("desktop lyrics native input window unavailable")
	}
	return setLinuxLyricsInputShape(win.NativeHandle(), ignored)
}
