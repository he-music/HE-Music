//go:build darwin

package darwin

import (
	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/egoist/mygo/internal/platform"
)

// An input region (SetInputRegion) lets the mouse through a window but
// where its rectangles are, as a desktop pet's window lets clicks through
// to the apps under it but on its character. AppKit has no such region:
// the window server hands a press to the window under it, and a window
// takes the mouse everywhere or nowhere (ignoresMouseEvents). Hit testing
// in the window (hitTest:) cannot help, since the window server already
// gave the press to the app: it never goes on to another app's window.
//
// So the window lets the mouse through while the pointer is outside the
// region, and takes it while the pointer is in it, switched as the
// pointer moves, before the press comes: a press then goes where the
// pointer is as it would through a region. The moves come from two
// monitors of the app's events, which only observe: the global one sees
// those the window server sends other apps, as while the window lets the
// mouse through, and the local one those this app gets, as while it takes
// it, which a tracking area of the content view, active always, asks for
// over the window when the app is not active. The pointer is read as it
// is now (mouseLocation), not where the event says it was, a move behind
// it. A button held keeps the window as it is, so that a drag that
// started on the character ends there, as one that started under the
// window ends there, and its release settles it
// (platform.LetsMouseThrough). A window moving or resizing under a still
// pointer, as a pet walking, follows it too (windowDidMove:,
// windowDidResize:), and so does a new region.
//
// The monitors exist while a window has a region: a global monitor of
// moves wakes the app at every move of the mouse over other apps.

var (
	// regionGlobal and regionLocal are the monitors of the pointer's
	// moves and releases while windows have input regions, or 0;
	// regionMovedGlobal and regionMovedLocal their handlers, made once.
	regionGlobal, regionLocal           id
	regionMovedGlobal, regionMovedLocal objc.Block
	regionBlocksMade                    bool
	// inputRegionMoved is (*window).followPointer and inputRegionClosed
	// (*window).closeInputRegion once the app set an input region, for
	// what every app has, the window's delegate, cleanup and
	// SetIgnoreMouseEvents, to call.
	inputRegionMoved, inputRegionClosed func(w *window)
)

// regionTracking is the options of the tracking area that asks for the
// pointer's moves over a window with an input region: moves, active
// always, in the visible rect.
const regionTracking = 0x02 | 0x80 | 0x200

func (w *window) SetIgnoreMouseEvents(v bool) {
	w.ignoreMouse = v
	w.ignoring = v
	send(w.win, "setIgnoresMouseEvents:", boolArg(v))
	if inputRegionMoved != nil {
		inputRegionMoved(w) // false gives the region back the mouse
	}
}

func (w *window) SetInputRegion(region []platform.Rect) {
	inputRegionMoved, inputRegionClosed = (*window).followPointer, (*window).closeInputRegion
	had := w.inputRegion != nil
	w.inputRegion = region
	switch {
	case region != nil && !had:
		if msgInitTracking == nil {
			purego.RegisterFunc(&msgInitTracking, msgSendAddr)
		}
		w.regionTracking = msgInitTracking(send(class("NSTrackingArea"), "alloc"), sel("initWithRect:options:owner:userInfo:"), NSRect{}, regionTracking, w.view, 0)
		send(w.view, "addTrackingArea:", uintptr(w.regionTracking))
	case region == nil && had:
		w.forgetInputRegion()
		if !w.ignoreMouse && w.ignoring {
			w.ignoring = false
			send(w.win, "setIgnoresMouseEvents:", boolArg(false))
		}
	}
	w.b.watchInputRegions()
	w.followPointer()
}

// forgetInputRegion removes the tracking area of the window's region.
func (w *window) forgetInputRegion() {
	if w.regionTracking != 0 {
		send(w.view, "removeTrackingArea:", uintptr(w.regionTracking))
		release(w.regionTracking)
		w.regionTracking = 0
	}
}

// closeInputRegion forgets the region of a window closing, which cleanup
// took out of the backend's windows, and the monitors once no window has
// one.
func (w *window) closeInputRegion() {
	if w.inputRegion != nil {
		w.forgetInputRegion()
		w.b.watchInputRegions()
	}
}

// followPointer lets the mouse through a window with an input region, or
// has it take the mouse, as the pointer is outside the region or in it.
func (w *window) followPointer() {
	if w.closed || w.ignoreMouse || w.inputRegion == nil {
		return
	}
	p := msgPoint(class("NSEvent"), sel("mouseLocation"))
	c := msgRectToRect(w.win, sel("contentRectForFrameRect:"), msgRect(w.win, sel("frame")))
	held := send(class("NSEvent"), "pressedMouseButtons") != 0
	// AppKit's y goes up from the bottom of the content.
	through := platform.LetsMouseThrough(w.inputRegion, p.X-c.Origin.X, c.Origin.Y+c.Size.Height-p.Y, held, w.ignoring)
	if through != w.ignoring {
		w.ignoring = through
		send(w.win, "setIgnoresMouseEvents:", boolArg(through))
	}
}

// watchInputRegions has the monitors watch the pointer while a window has
// an input region, and removes them once none has.
func (b *Backend) watchInputRegions() {
	regions := false
	for _, w := range b.byNSWindow {
		if w.inputRegion != nil && !w.closed {
			regions = true
			break
		}
	}
	if regions == (regionGlobal != 0) {
		return
	}
	if !regions {
		send(class("NSEvent"), "removeMonitor:", uintptr(regionGlobal))
		send(class("NSEvent"), "removeMonitor:", uintptr(regionLocal))
		release(regionGlobal)
		release(regionLocal)
		regionGlobal, regionLocal = 0, 0
		return
	}
	if !regionBlocksMade {
		regionBlocksMade = true
		regionMovedGlobal = newBlock(func(_ objc.Block, ev id) { b.pointerMoved() })
		regionMovedLocal = newBlock(func(_ objc.Block, ev id) id {
			b.pointerMoved()
			return ev
		})
	}
	// Moves, and left, right and other mouse up.
	const mask = 1<<5 | 1<<2 | 1<<4 | 1<<26
	regionGlobal = retain(send(class("NSEvent"), "addGlobalMonitorForEventsMatchingMask:handler:", mask, uintptr(regionMovedGlobal)))
	regionLocal = retain(send(class("NSEvent"), "addLocalMonitorForEventsMatchingMask:handler:", mask, uintptr(regionMovedLocal)))
}

// pointerMoved has each window with an input region follow the pointer.
func (b *Backend) pointerMoved() {
	for _, w := range b.byNSWindow {
		if w.inputRegion != nil {
			w.followPointer()
		}
	}
}
