//go:build linux

package main

import (
	"errors"
	"fmt"
	"log"
	"sync"

	"github.com/ebitengine/purego"
)

type linuxGTKList struct {
	data           uintptr
	next, previous *linuxGTKList
}

var linuxWebViewPolicy struct {
	sync.Once
	access nativeWebViewPolicyAccess
	err    error
}

// RTLD_NOLOAD only acquires libraries already owned by mygo. Loading a second
// WebKit ABI into the process could give the same widget incompatible GTypes.
const linuxPolicyRTLDNoLoad = 4

func linuxNativeWebViewPolicy() (nativeWebViewPolicyAccess, error) {
	linuxWebViewPolicy.Do(func() {
		linuxWebViewPolicy.access, linuxWebViewPolicy.err = loadLinuxWebViewPolicy()
	})
	return linuxWebViewPolicy.access, linuxWebViewPolicy.err
}

func loadLinuxWebViewPolicy() (access nativeWebViewPolicyAccess, err error) {
	var libraries []uintptr
	defer func() {
		if failure := recover(); failure != nil {
			err = fmt.Errorf("Linux WebKitGTK policy binding: %v", failure)
		}
		if err != nil {
			for _, library := range libraries {
				_ = purego.Dlclose(library)
			}
			access = nativeWebViewPolicyAccess{}
		}
	}()
	open := func(names ...string) (uintptr, error) {
		for _, name := range names {
			library, openErr := purego.Dlopen(name, purego.RTLD_NOW|linuxPolicyRTLDNoLoad)
			if openErr == nil {
				libraries = append(libraries, library)
				return library, nil
			}
		}
		return 0, errors.New("Linux WebKitGTK policy library is not loaded")
	}
	gtk, err := open("libgtk-3.so.0")
	if err != nil {
		return access, err
	}
	gobject, err := open("libgobject-2.0.so.0")
	if err != nil {
		return access, err
	}
	webkit, err := open("libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37")
	if err != nil {
		return access, err
	}
	var containerType, webViewType func() uintptr
	var instanceIsA func(uintptr, uintptr) int32
	var getChildren func(uintptr) *linuxGTKList
	var freeList func(*linuxGTKList)
	var getSettings func(uintptr) uintptr
	var getGesture func(uintptr) int32
	var setGesture func(uintptr, int32)
	var getAcceleration func(uintptr) int32
	var setAcceleration func(uintptr, int32)
	var connectSignal func(uintptr, string, uintptr, uintptr, uintptr, uint32) uintptr
	var draw nativeTransparentDrawAccess
	purego.RegisterLibFunc(&containerType, gtk, "gtk_container_get_type")
	purego.RegisterLibFunc(&getChildren, gtk, "gtk_container_get_children")
	purego.RegisterLibFunc(&instanceIsA, gobject, "g_type_check_instance_is_a")
	purego.RegisterLibFunc(&freeList, gobject, "g_list_free")
	purego.RegisterLibFunc(&webViewType, webkit, "webkit_web_view_get_type")
	purego.RegisterLibFunc(&getSettings, webkit, "webkit_web_view_get_settings")
	purego.RegisterLibFunc(&getGesture, webkit, "webkit_settings_get_media_playback_requires_user_gesture")
	purego.RegisterLibFunc(&setGesture, webkit, "webkit_settings_set_media_playback_requires_user_gesture")
	purego.RegisterLibFunc(&getAcceleration, webkit, "webkit_settings_get_hardware_acceleration_policy")
	purego.RegisterLibFunc(&setAcceleration, webkit, "webkit_settings_set_hardware_acceleration_policy")
	purego.RegisterLibFunc(&connectSignal, gobject, "g_signal_connect_data")
	purego.RegisterLibFunc(&draw.save, gtk, "cairo_save")
	purego.RegisterLibFunc(&draw.setOperator, gtk, "cairo_set_operator")
	purego.RegisterLibFunc(&draw.paint, gtk, "cairo_paint")
	purego.RegisterLibFunc(&draw.restore, gtk, "cairo_restore")
	// One callback per process; GTK disconnects the signal when its window dies.
	var firstDraw sync.Once
	clearBackground := purego.NewCallback(func(_, context, _ uintptr) int32 {
		clearNativeTransparentBackground(context, draw)
		if context != 0 {
			firstDraw.Do(func() {
				log.Print("Linux WebKitGTK: lyrics WebView background clear executed")
			})
		}
		return 0 // continue WebKit's default draw on the same cairo context
	})
	container, view := containerType(), webViewType()
	access = nativeWebViewPolicyAccess{
		isWebView: func(widget uintptr) bool { return instanceIsA(widget, view) != 0 },
		children: func(widget uintptr) []uintptr {
			if instanceIsA(widget, container) == 0 {
				return nil
			}
			list := getChildren(widget)
			if list == nil {
				return nil
			}
			defer freeList(list)
			var children []uintptr
			for node := list; node != nil && len(children) < 128; node = node.next {
				children = append(children, node.data)
			}
			return children
		},
		settings:        getSettings,
		requiresGesture: func(settings uintptr) bool { return getGesture(settings) != 0 },
		setGesture: func(settings uintptr, required bool) {
			var value int32
			if required {
				value = 1
			}
			setGesture(settings, value)
		},
		acceleration:    getAcceleration,
		setAcceleration: setAcceleration,
		prepareTransparentBackground: func(view uintptr) error {
			// WebKitWebViewBase owns a GdkWindow. Clearing the outer GtkWindow
			// does not clear this widget's drawing destination or child-window clip.
			if connectSignal(view, "draw", clearBackground, 0, 0, 0) == 0 {
				return errors.New("Linux transparent WebView draw handler is unavailable")
			}
			return nil
		},
	}
	return access, nil
}

func configureNativeWebViewMedia(handle uintptr) error {
	access, err := linuxNativeWebViewPolicy()
	if err != nil {
		return err
	}
	if err := applyNativePlaybackPolicy(handle, access); err != nil {
		return err
	}
	log.Print("Linux WebKitGTK: media gesture policy applied")
	return nil
}

func configureNativeLyricsRendering(handle uintptr) error {
	access, err := linuxNativeWebViewPolicy()
	if err != nil {
		return err
	}
	if err := applyNativeLyricsRenderingPolicy(handle, access); err != nil {
		return err
	}
	log.Print("Linux WebKitGTK: lyrics compositing enabled; WebView clear handler installed")
	return nil
}
