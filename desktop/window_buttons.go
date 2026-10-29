package main

import "fmt"

// windowButtonsRect uses the tracking view's coordinates, not ContentSize:
// AppKit's full-size content view includes the hidden title bar.
type windowButtonsRect struct{ X, Y, Width, Height float64 }

func windowButtonsHoverRect(bounds windowButtonsRect, flipped bool) windowButtonsRect {
	r := windowButtonsRect{X: bounds.X, Y: bounds.Y, Width: min(88, max(0, bounds.Width)), Height: min(70, max(0, bounds.Height))}
	if !flipped {
		r.Y += max(0, bounds.Height) - r.Height
	}
	return r
}

type windowButtonsNative interface {
	newArea(windowButtonsRect) (uintptr, error)
	addArea(uintptr) error
	containsPointer(windowButtonsRect) bool
	removeArea(uintptr)
	showButtons(bool)
	release()
}

// All controller operations run on the AppKit main thread. An event must carry
// its tracking-area identity so queued events from replaced areas are ignored.
type windowButtonsHover struct {
	native   windowButtonsNative
	area     uintptr
	disposed bool
	unroute  func()
	off      []func()
}

func (h *windowButtonsHover) refresh(bounds windowButtonsRect, flipped bool) error {
	if h.disposed {
		return nil
	}
	old := h.area
	h.area = 0
	if old != 0 {
		h.native.removeArea(old)
	}
	h.native.showButtons(false)
	rect := windowButtonsHoverRect(bounds, flipped)
	area, err := h.native.newArea(rect)
	if err != nil || area == 0 {
		h.dispose()
		if err == nil {
			err = fmt.Errorf("NSTrackingArea 初始化返回 nil")
		}
		return err
	}
	h.area = area // addTrackingArea: may synchronously deliver an event.
	if err := h.native.addArea(area); err != nil {
		h.dispose()
		return err
	}
	if !h.disposed && h.area == area {
		h.native.showButtons(h.native.containsPointer(rect))
	}
	return nil
}

func (h *windowButtonsHover) entered(area uintptr, inside bool) {
	if !h.disposed && area != 0 && area == h.area {
		h.native.showButtons(inside)
	}
}

// Full screen uses AppKit's title bar and auto-hide behavior. A later refresh
// restores the custom hover area on leaving full screen.
func (h *windowButtonsHover) suspend() {
	if h.disposed {
		return
	}
	area := h.area
	h.area = 0
	if area != 0 {
		h.native.removeArea(area)
	}
	h.native.showButtons(true)
}

func (h *windowButtonsHover) dispose() {
	if h.disposed {
		return
	}
	h.disposed = true
	area := h.area
	h.area = 0
	// Remove routing before touching AppKit, which can reenter Go callbacks.
	if h.unroute != nil {
		h.unroute()
	}
	if area != 0 {
		h.native.removeArea(area)
	}
	for _, off := range h.off {
		off()
	}
	h.off = nil
	// Also used for rollback: always leave a native close entry available.
	h.native.showButtons(true)
	h.native.release()
}
