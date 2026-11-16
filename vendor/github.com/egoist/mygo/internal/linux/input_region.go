//go:build linux && (amd64 || arm64)

package linux

import "github.com/egoist/mygo/internal/platform"

// An input region (SetInputRegion) lets the pointer through a window but
// where its rectangles are, as a desktop pet's window lets clicks through
// to the windows under it but on its character: the window's input shape
// is the region (applyInputShape), which X11's SHAPE extension and
// Wayland's input region of the surface (wl_surface_set_input_region) put
// in place of the window's own. The X server and the compositor then hand
// a press outside it to what is beneath, another app's window too, as
// they would were the window not there.

// shapeInputRegion is (*window).shapeInputRegion once the app set an
// input region, for applyInputShape, which every app has, to call.
var shapeInputRegion func(w *window, win ptr)

func (w *window) SetInputRegion(region []platform.Rect) {
	shapeInputRegion = (*window).shapeInputRegion
	w.inputRegion = region
	w.applyInputShape(true)
}

// shapeInputRegion gives the window's GdkWindow win the input shape of
// its region, where the content is in it.
func (w *window) shapeInputRegion(win ptr) {
	region := cairoRegionCreateRectangle(&gdkRectangle{})
	for _, r := range w.inputRegion {
		cairoRegionUnionRectangle(region, &gdkRectangle{X: int32(r.X), Y: int32(r.Y), Width: int32(r.Width), Height: int32(r.Height)})
	}
	x, y := w.contentInWindow()
	gdkWindowInputShapeCombineRegion(win, region, x, y)
	cairoRegionDestroy(region)
}

// contentInWindow returns where the content is in the window's
// GdkWindow, which holds the menu bar, and the shadow GTK draws around a
// window it decorates itself, as flyouts are placed from it.
func (w *window) contentInWindow() (x, y int32) {
	loadFlyouts() // binds gtk_widget_translate_coordinates
	if c := w.contentWidget(); c == 0 || !gtkWidgetTranslateCoordinates(c, w.win, 0, 0, &x, &y) {
		x, y = 0, w.contentInsets().top
	}
	var alloc gdkRectangle
	gtkWidgetGetAllocation(w.win, &alloc)
	return x + alloc.X, y + alloc.Y
}
