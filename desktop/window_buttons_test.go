package main

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

type fakeWindowButtons struct {
	next          uintptr
	visible       bool
	released      bool
	areas         map[uintptr]windowButtonsRect
	operations    []string
	newErr        error
	addErr        error
	nilArea       bool
	onRemove      func(uintptr)
	pointerInside bool
	onAdd         func(uintptr)
}

func (n *fakeWindowButtons) containsPointer(windowButtonsRect) bool { return n.pointerInside }
func (n *fakeWindowButtons) newArea(r windowButtonsRect) (uintptr, error) {
	if n.newErr != nil || n.nilArea {
		return 0, n.newErr
	}
	n.next++
	if n.areas == nil {
		n.areas = make(map[uintptr]windowButtonsRect)
	}
	n.areas[n.next] = r
	return n.next, nil
}
func (n *fakeWindowButtons) addArea(area uintptr) error {
	if n.onAdd != nil {
		n.onAdd(area)
	}
	return n.addErr
}
func (n *fakeWindowButtons) removeArea(area uintptr) {
	n.operations = append(n.operations, fmt.Sprintf("remove:%d", area))
	if n.onRemove != nil {
		n.onRemove(area)
	}
	delete(n.areas, area)
}
func (n *fakeWindowButtons) showButtons(show bool) {
	if n.released {
		panic("access after release")
	}
	n.visible = show
	n.operations = append(n.operations, fmt.Sprintf("visible:%t", show))
}
func (n *fakeWindowButtons) release() {
	if n.released || len(n.areas) != 0 {
		panic("unbalanced release")
	}
	n.released = true
	n.operations = append(n.operations, "release")
}

func TestWindowButtonsAlreadyInsideWithoutEnteredEvent(t *testing.T) {
	n := &fakeWindowButtons{pointerInside: true}
	h := &windowButtonsHover{native: n}
	bounds := windowButtonsRect{Width: 1280, Height: 800}
	if err := h.refresh(bounds, false); err != nil || !n.visible {
		t.Fatal("stationary pointer already inside must show controls without an entered event", err)
	}
	n.pointerInside = false
	if err := h.refresh(bounds, false); err != nil || n.visible {
		t.Fatal("resize must synchronize the current outside pointer", err)
	}
	h.suspend()
	n.pointerInside = true
	if err := h.refresh(bounds, false); err != nil || !n.visible {
		t.Fatal("leaving full screen must synchronize the stationary pointer", err)
	}
	h.dispose()
}
func TestWindowButtonsHoverRect(t *testing.T) {
	for _, tc := range []struct {
		name    string
		bounds  windowButtonsRect
		flipped bool
		want    windowButtonsRect
	}{
		{"bottom-origin", windowButtonsRect{0, 0, 1280, 800}, false, windowButtonsRect{0, 730, 88, 70}},
		{"flipped", windowButtonsRect{0, 0, 1280, 800}, true, windowButtonsRect{0, 0, 88, 70}},
		{"bounds-offset", windowButtonsRect{3, 5, 100, 100}, false, windowButtonsRect{3, 35, 88, 70}},
		{"small", windowButtonsRect{0, 0, 40, 30}, false, windowButtonsRect{0, 0, 40, 30}},
		{"empty", windowButtonsRect{0, 0, 0, 0}, false, windowButtonsRect{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := windowButtonsHoverRect(tc.bounds, tc.flipped); got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestWindowButtonsHoverEventsResizeAndDispose(t *testing.T) {
	n := &fakeWindowButtons{visible: true}
	h := &windowButtonsHover{native: n}
	routed := true
	h.unroute = func() { routed = false; n.operations = append(n.operations, "unroute") }
	h.off = []func(){func() { n.operations = append(n.operations, "off-resize") }, func() { n.operations = append(n.operations, "off-closed") }}
	if err := h.refresh(windowButtonsRect{Width: 1280, Height: 800}, false); err != nil {
		t.Fatal(err)
	}
	first := h.area
	if n.visible {
		t.Fatal("buttons initially visible")
	}
	h.entered(first, true)
	if !n.visible {
		t.Fatal("entered did not show buttons")
	}
	h.entered(first, false)
	if n.visible {
		t.Fatal("exited did not hide buttons")
	}
	// Removing an area may synchronously deliver its last entered event.
	n.onRemove = func(area uintptr) { h.entered(area, true) }
	// Adding an area may synchronously deliver the first entered event.
	n.pointerInside = true
	n.onAdd = func(area uintptr) { h.entered(area, true) }
	if err := h.refresh(windowButtonsRect{Width: 900, Height: 600}, false); err != nil {
		t.Fatal(err)
	}
	if !n.visible || len(n.areas) != 1 || n.areas[h.area].Y != 530 {
		t.Fatal("resize did not replace geometry or accept current entered event")
	}
	h.entered(first, false)
	if !n.visible {
		t.Fatal("stale event changed buttons")
	}
	n.operations = nil
	n.onRemove = func(area uintptr) {
		if routed {
			t.Error("routing still live during native teardown")
		}
		h.entered(area, false)
	}
	h.dispose() // Same production cleanup used by OnClosed and explicit dispose.
	want := []string{"unroute", "remove:2", "off-resize", "off-closed", "visible:true", "release"}
	if !reflect.DeepEqual(n.operations, want) || !n.visible || !h.disposed {
		t.Fatalf("cleanup: %v, want %v", n.operations, want)
	}
	h.dispose()
	h.entered(first, false)
	h.suspend()
	if err := h.refresh(windowButtonsRect{}, true); err != nil || !reflect.DeepEqual(n.operations, want) {
		t.Fatal("old callbacks or duplicate disposal accessed native objects")
	}
}

func TestWindowButtonsHoverFullscreen(t *testing.T) {
	n := &fakeWindowButtons{}
	h := &windowButtonsHover{native: n}
	bounds := windowButtonsRect{Width: 1280, Height: 800}
	if err := h.refresh(bounds, true); err != nil {
		t.Fatal(err)
	}
	old := h.area
	h.suspend()
	h.entered(old, false)
	if !n.visible || h.area != 0 || len(n.areas) != 0 || n.released {
		t.Fatal("full screen must return title bar visibility to AppKit")
	}
	if err := h.refresh(bounds, true); err != nil || n.visible || h.area == 0 {
		t.Fatal("leaving full screen must restore hover")
	}
	h.dispose()
}

func TestWindowButtonsHoverFailureRollback(t *testing.T) {
	failure := errors.New("fixture failure")
	for _, stage := range []string{"allocation", "nil-area", "attachment", "resize"} {
		t.Run(stage, func(t *testing.T) {
			n := &fakeWindowButtons{}
			h := &windowButtonsHover{native: n}
			routed, listening := true, true
			h.unroute = func() { routed = false }
			h.off = []func(){func() { listening = false }}
			if stage == "resize" {
				if err := h.refresh(windowButtonsRect{Width: 100, Height: 100}, false); err != nil {
					t.Fatal(err)
				}
			}
			switch stage {
			case "allocation", "resize":
				n.newErr = failure
			case "attachment":
				n.addErr = failure
			case "nil-area":
				n.nilArea = true
			}
			err := h.refresh(windowButtonsRect{Width: 100, Height: 100}, false)
			if err == nil || (stage != "nil-area" && !errors.Is(err, failure)) {
				t.Fatalf("real failure not propagated: %v", err)
			}
			if !h.disposed || !n.visible || !n.released || routed || listening || len(n.areas) != 0 {
				t.Fatal("rollback did not release resources and restore native close entry")
			}
			h.dispose()
		})
	}
}
