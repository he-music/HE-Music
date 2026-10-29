package main

import "math"

// The child reports its actual unlock button as a viewport-relative rectangle.
// Native code alone decides when that small region accepts mouse input.
type LyricsUnlockRegion struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func validLyricsUnlockRegion(region LyricsUnlockRegion, bounds LyricsBounds) bool {
	for _, value := range []float64{region.X, region.Y, region.Width, region.Height} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return bounds.Width > 0 && bounds.Height > 0 && region.X >= 0 && region.Y >= 0 &&
		region.Width > 0 && region.Height > 0 && region.X+region.Width <= 1 && region.Y+region.Height <= 1 &&
		region.Width*float64(bounds.Width) <= 64 && region.Height*float64(bounds.Height) <= 64
}

type lyricsHoverWatcher struct {
	current              func() bool
	sample               func() (LyricsBounds, int, int, *LyricsUnlockRegion)
	schedule             func(func()) func()
	onHover              func(bool)
	onInput              func(bool)
	sequence             uint64
	cancel               func()
	hovered, interactive bool
}

func (w *lyricsHoverWatcher) start() {
	w.stop()
	w.poll(w.sequence)
}

func (w *lyricsHoverWatcher) stop() {
	w.sequence++
	if w.cancel != nil {
		w.cancel()
		w.cancel = nil
	}
	w.update(false, false)
}

func (w *lyricsHoverWatcher) update(hovered, interactive bool) {
	if w.hovered != hovered {
		w.hovered = hovered
		w.onHover(hovered)
	}
	if w.interactive != interactive {
		w.interactive = interactive
		w.onInput(interactive)
	}
}

func (w *lyricsHoverWatcher) poll(sequence uint64) {
	if sequence != w.sequence {
		return
	}
	if !w.current() {
		w.stop()
		return
	}
	bounds, x, y, region := w.sample()
	localX, localY := x-bounds.X, y-bounds.Y
	hovered := bounds.Width > 0 && bounds.Height > 0 && localX >= 0 && localY >= 0 && localX < bounds.Width && localY < bounds.Height
	interactive := false
	if hovered && region != nil && validLyricsUnlockRegion(*region, bounds) {
		nx, ny := float64(localX)/float64(bounds.Width), float64(localY)/float64(bounds.Height)
		interactive = nx >= region.X && nx < region.X+region.Width && ny >= region.Y && ny < region.Y+region.Height
	}
	w.update(hovered, interactive)
	if sequence == w.sequence && w.current() {
		w.cancel = w.schedule(func() { w.poll(sequence) })
	}
}
