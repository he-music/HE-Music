//go:build linux

package main

import (
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/ebitengine/purego"
)

// Run explicitly in an isolated X11 display. The default test suite remains
// headless; this verifies real pointer delivery through a GTK child GdkWindow.
func TestLinuxLyricsInputShapePointerDelivery(t *testing.T) {
	if os.Getenv("HE_MUSIC_GTK_INPUT_TEST") != "1" {
		t.Skip("requires an isolated X11 display and HE_MUSIC_GTK_INPUT_TEST=1")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	gtk, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	xlib, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	xtest, err := purego.Dlopen("libXtst.so.6", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	var initGTK func(uintptr, uintptr) int32
	var newWindow func(int32) uintptr
	var newArea func() uintptr
	var decorate, keepAbove func(uintptr, int32)
	var resize, move func(uintptr, int32, int32)
	var show, destroy func(uintptr)
	var addChild func(uintptr, uintptr)
	var addEvents func(uintptr, int32)
	var getWindow func(uintptr) uintptr
	var raise func(uintptr)
	var getDisplay func(uintptr) uintptr
	var syncGTKDisplay func(uintptr)
	var width func(uintptr) int32
	var pending func() int32
	var iterate func(int32) int32
	var connect func(uintptr, string, uintptr, uintptr, uintptr, uint32) uintptr
	purego.RegisterLibFunc(&initGTK, gtk, "gtk_init_check")
	purego.RegisterLibFunc(&newWindow, gtk, "gtk_window_new")
	purego.RegisterLibFunc(&newArea, gtk, "gtk_drawing_area_new")
	purego.RegisterLibFunc(&decorate, gtk, "gtk_window_set_decorated")
	purego.RegisterLibFunc(&keepAbove, gtk, "gtk_window_set_keep_above")
	purego.RegisterLibFunc(&resize, gtk, "gtk_window_resize")
	purego.RegisterLibFunc(&move, gtk, "gtk_window_move")
	purego.RegisterLibFunc(&addChild, gtk, "gtk_container_add")
	purego.RegisterLibFunc(&addEvents, gtk, "gtk_widget_add_events")
	purego.RegisterLibFunc(&show, gtk, "gtk_widget_show_all")
	purego.RegisterLibFunc(&destroy, gtk, "gtk_widget_destroy")
	purego.RegisterLibFunc(&getWindow, gtk, "gtk_widget_get_window")
	purego.RegisterLibFunc(&raise, gtk, "gdk_window_raise")
	purego.RegisterLibFunc(&getDisplay, gtk, "gdk_window_get_display")
	purego.RegisterLibFunc(&syncGTKDisplay, gtk, "gdk_display_sync")
	purego.RegisterLibFunc(&width, gtk, "gtk_widget_get_allocated_width")
	purego.RegisterLibFunc(&pending, gtk, "gtk_events_pending")
	purego.RegisterLibFunc(&iterate, gtk, "gtk_main_iteration_do")
	purego.RegisterLibFunc(&connect, gtk, "g_signal_connect_data")
	if initGTK(0, 0) == 0 {
		t.Fatal("isolated GTK display unavailable")
	}
	var openDisplay func(uintptr) uintptr
	var syncDisplay func(uintptr, int32) int32
	var closeDisplay func(uintptr) int32
	var motion func(uintptr, int32, int32, int32, uintptr) int32
	var button func(uintptr, uint32, int32, uintptr) int32
	purego.RegisterLibFunc(&openDisplay, xlib, "XOpenDisplay")
	purego.RegisterLibFunc(&syncDisplay, xlib, "XSync")
	purego.RegisterLibFunc(&closeDisplay, xlib, "XCloseDisplay")
	purego.RegisterLibFunc(&motion, xtest, "XTestFakeMotionEvent")
	purego.RegisterLibFunc(&button, xtest, "XTestFakeButtonEvent")
	display := openDisplay(0)
	if display == 0 {
		t.Fatal("isolated X11 display unavailable")
	}
	defer closeDisplay(display)
	var clicks [3]int
	press := purego.NewCallback(func(_ uintptr, _ uintptr, target uintptr) int32 {
		if target > 0 && target < 3 {
			clicks[target]++
		}
		return 1
	})
	wait := func(description string, condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(time.Minute)
		for !condition() {
			for pending() != 0 {
				iterate(0)
			}
			iterate(0)
			if time.Now().After(deadline) {
				t.Fatalf("GTK input test hung: %s; clicks=%v", description, clicks)
			}
			runtime.Gosched()
		}
	}
	create := func(target uintptr) uintptr {
		win := newWindow(0)
		decorate(win, 0)
		resize(win, 400, 200)
		move(win, 100, 100)
		area := newArea()
		addEvents(area, 1<<8) // GDK_BUTTON_PRESS_MASK
		addChild(win, area)
		if connect(area, "button-press-event", press, target, 0, 0) == 0 {
			t.Fatal("cannot connect input test handler")
		}
		show(win)
		wait("window realized", func() bool { return getWindow(win) != 0 && width(win) == 400 })
		return win
	}
	bottom := create(1)
	defer destroy(bottom)
	top := create(2)
	defer func() { destroy(top) }()
	keepAbove(top, 1)
	click := func(target int, x, y int32) {
		t.Helper()
		before := clicks
		raise(getWindow(top))
		// Shape/stack changes belong to GTK's X connection, not XTest's.
		syncGTKDisplay(getDisplay(getWindow(top)))
		syncDisplay(display, 0)
		if motion(display, -1, x, y, 0) == 0 || button(display, 1, 1, 0) == 0 || button(display, 1, 0, 0) == 0 {
			t.Fatal("XTest input injection failed")
		}
		syncDisplay(display, 0)
		wait("pointer delivered", func() bool { return clicks[target] > before[target] })
		other := 3 - target
		if clicks[other] != before[other] {
			t.Fatalf("pointer reached both layers: before=%v after=%v", before, clicks)
		}
	}
	// The SDK's current Linux no-op is equivalent to this unmodified input area.
	click(2, 160, 160)
	if err := setLinuxLyricsInputShape(top, true); err != nil {
		t.Fatal(err)
	}
	click(1, 160, 160)

	// The hover affordance may capture only when the pointer is at its button;
	// moving back into the lyric body must re-enable native pass-through.
	cursorX, cursorY := 160, 160
	region := &LyricsUnlockRegion{X: .8, Y: .05, Width: .1, Height: .2}
	var next func()
	watcher := &lyricsHoverWatcher{
		current: func() bool { return true },
		sample: func() (LyricsBounds, int, int, *LyricsUnlockRegion) {
			return LyricsBounds{X: 100, Y: 100, Width: 400, Height: 200}, cursorX, cursorY, region
		},
		schedule: func(tick func()) func() { next = tick; return func() {} },
		onHover:  func(bool) {},
		onInput: func(interactive bool) {
			if err := setLinuxLyricsInputShape(top, !interactive); err != nil {
				t.Fatal(err)
			}
		},
	}
	watcher.start()
	click(1, 160, 160)
	cursorX, cursorY = 430, 120
	next()
	click(2, 430, 120)
	cursorX, cursorY = 160, 160
	next()
	click(1, 160, 160)
	watcher.stop()

	resize(top, 500, 240)
	wait("locked window resized", func() bool { return width(top) == 500 })
	click(1, 160, 160)
	if err := setLinuxLyricsInputShape(top, false); err != nil {
		t.Fatal(err)
	}
	click(2, 160, 160)

	// Reopening creates an independent native input area.
	destroy(top)
	top = create(2)
	click(2, 160, 160)
	if err := setLinuxLyricsInputShape(top, true); err != nil {
		t.Fatal(err)
	}
	click(1, 160, 160)
	if err := setLinuxLyricsInputShape(top, false); err != nil {
		t.Fatal(err)
	}
	click(2, 160, 160)
	t.Logf("native GTK input verified: lower window clicks=%d, lyric layer clicks=%d", clicks[1], clicks[2])
}
