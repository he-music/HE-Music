//go:build windows && (amd64 || arm64)

package windows

import (
	"unsafe"

	"github.com/egoist/mygo/internal/platform"
)

// An input region (SetInputRegion) lets the mouse through a window but
// where its rectangles are, as a desktop pet's window lets clicks through
// to the apps under it but on its character. Windows hands a press to the
// window the system finds under it, and lets one through to another app's
// window only where the window is layered and transparent to the mouse
// (WS_EX_LAYERED with WS_EX_TRANSPARENT), all of it or none. WM_NCHITTEST
// answering HTTRANSPARENT goes on to windows of the same thread alone, never
// another app's. A layered window lets the mouse through its fully
// transparent pixels only when it draws with UpdateLayeredWindow, which
// neither WebView2 nor native UI's DirectComposition does. And SetWindowRgn,
// which shapes the window's input, shapes what it shows too: it would cut
// off what the content draws outside the region, a shadow or a glow, along
// pixel edges.
//
// So the window lets the mouse through while the cursor is outside the
// region, and takes it while the cursor is in it, switching
// WS_EX_TRANSPARENT before the press comes: a press then goes where the
// cursor is as it would through a region. A window letting the mouse
// through gets no WM_MOUSEMOVE, so the cursor is asked where it is
// (GetCursorPos) on a timer of the window's, at each tick of the
// system's clock (15.6 ms) while it shows, which costs next to nothing, and needs neither a low-level mouse
// hook, which slows every move of the system's mouse while the main
// thread is busy, nor raw input, which a process registers once for every
// window and library in it. A button held keeps the window as it is, so
// that a drag that started on the character ends there, as one that
// started under the window ends there, and its release settles it
// (platform.LetsMouseThrough). The window stays layered while it has a
// region: making it layered and not again would redraw it as the cursor
// comes and goes.

const (
	timerInputRegion = 5 // the window's timer that asks where the cursor is
	// inputRegionPoll is the milliseconds between asks: the least SetTimer
	// takes (USER_TIMER_MINIMUM), which fires at each tick of the system's
	// clock, 15.6 ms. A timer rounds its time up to whole ticks, so 16 ms
	// fired every other tick, 31 ms apart: a press that came 17 to 35 ms
	// after the cursor entered the region could find the window switching
	// as Windows routed it, and went to no window at all.
	inputRegionPoll = 10
)

var (
	procGetAsyncKeyState = user32.NewProc("GetAsyncKeyState")
	// checkInputRegion is (*window).followCursor and inputRegionShown
	// (*window).pollCursor once the app set an input region, for what
	// every app has, the window's messages and SetIgnoreMouseEvents, to
	// call.
	checkInputRegion func(w *window)
	inputRegionShown func(w *window, shown bool)
)

func (w *window) SetIgnoreMouseEvents(v bool) {
	w.ignoreMouse, w.through = v, v
	w.setExStyle(wsExTransparent, v)
	w.updateLayered()
	if checkInputRegion != nil {
		checkInputRegion(w) // false gives the region back the mouse
	}
}

func (w *window) SetInputRegion(region []platform.Rect) {
	checkInputRegion, inputRegionShown = (*window).followCursor, (*window).pollCursor
	w.inputRegion = region
	if region == nil && !w.ignoreMouse && w.through {
		w.through = false
		w.setExStyle(wsExTransparent, false)
	}
	w.updateLayered()
	shown, _, _ := procIsWindowVisible.Call(w.hwnd)
	w.pollCursor(shown != 0)
	w.followCursor()
}

// pollCursor asks where the cursor is while a window with an input region
// shows, and stops asking otherwise.
func (w *window) pollCursor(shown bool) {
	if w.inputRegion != nil && shown {
		procSetTimer.Call(w.hwnd, timerInputRegion, inputRegionPoll, 0)
	} else {
		procKillTimer.Call(w.hwnd, timerInputRegion)
	}
}

// followCursor lets the mouse through a window with an input region, or
// has it take the mouse, as the cursor is outside the region or in it.
func (w *window) followCursor() {
	if w.closed || w.ignoreMouse || w.inputRegion == nil {
		return
	}
	if iconic, _, _ := procIsIconic.Call(w.hwnd); iconic != 0 {
		return
	}
	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procScreenToClient.Call(w.hwnd, uintptr(unsafe.Pointer(&pt)))
	scale := float64(dpiOf(w.hwnd)) / 96
	through := platform.LetsMouseThrough(w.inputRegion, float64(pt.X)/scale, float64(pt.Y)/scale, buttonsHeld(), w.through)
	if through != w.through {
		w.through = through
		w.setExStyle(wsExTransparent, through)
	}
}

// buttonsHeld reports whether a button of the mouse is down, whichever
// window has it: the left, right, middle and the two side buttons.
func buttonsHeld() bool {
	for _, vk := range [...]uintptr{0x01, 0x02, 0x04, 0x05, 0x06} {
		if r, _, _ := procGetAsyncKeyState.Call(vk); r&0x8000 != 0 {
			return true
		}
	}
	return false
}
