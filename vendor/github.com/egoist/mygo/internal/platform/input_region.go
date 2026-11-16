package platform

// InRegion reports whether x, y is in one of the rectangles of region,
// their far edges excluded: the input region of a window
// (Window.SetInputRegion), in DIPs from the top-left corner of its
// content.
func InRegion(region []Rect, x, y float64) bool {
	for _, r := range region {
		if x >= float64(r.X) && y >= float64(r.Y) && x < float64(r.X+r.Width) && y < float64(r.Y+r.Height) {
			return true
		}
	}
	return false
}

// LetsMouseThrough tells whether a window with an input region lets the
// mouse through to what is behind it, the pointer at x, y in DIPs from
// the top-left corner of its content, for a backend whose system shapes
// no window's input and lets the mouse through all of a window or none of
// it (macOS, Windows), switching as the pointer moves: through outside
// the rectangles, and as it was, through, while a button is held, held.
// A press that started on the window, as one dragging it by its character,
// keeps the window until it ends, as one that started behind it keeps
// what is behind; the release settles it.
func LetsMouseThrough(region []Rect, x, y float64, held, through bool) bool {
	if held {
		return through
	}
	return !InRegion(region, x, y)
}
