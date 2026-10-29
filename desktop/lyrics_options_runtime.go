package main

import (
	"context"
	"errors"
	"math"

	"github.com/egoist/mygo"
)

// ResetPosition is a main-page recovery action. It never shows or unlocks the window.
func (l *DesktopLyrics) ResetPosition(ctx context.Context, epoch uint64) (LyricsWindowState, error) {
	var result LyricsWindowState
	err := l.call(ctx, epoch, false, func() error {
		if l.state.window.Locked || l.state.window.Pending {
			return errors.New("desktop lyrics window is locked or pending")
		}
		size := l.optionsFontSize()
		bounds, err := resetLyricsBounds(lyricsWorkAreas(), size)
		if err != nil {
			return err
		}
		l.applyOptionsBounds(bounds)
		l.appliedFontSize = size
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) optionsFontSize() int {
	if l.state.snapshot != nil && l.state.snapshot.Options != nil {
		return l.state.snapshot.Options.Font.Size
	}
	return defaultLyricsOptions().Font.Size
}

// A locked window keeps its native bounds. Imported size changes apply after unlock.
func (l *DesktopLyrics) syncOptionsBounds() error {
	size := l.optionsFontSize()
	if size == l.appliedFontSize || l.state.window.Locked {
		return nil
	}
	bounds, err := lyricsBoundsForFont(l.state.window.Bounds, size, lyricsWorkAreas())
	if err != nil {
		return err
	}
	l.applyOptionsBounds(bounds)
	l.appliedFontSize = size
	return nil
}

func (l *DesktopLyrics) applyOptionsBounds(bounds LyricsBounds) {
	if l.win != nil && !l.win.IsDestroyed() {
		l.win.SetBounds(mygo.Rectangle(bounds))
		l.readBounds()
		return
	}
	if l.state.window.Bounds != bounds {
		l.state.window.Bounds = bounds
		l.state.window.Revision++
		l.emitWindow()
	}
}

// Use one actual work area, so restricting a drag cannot span gaps between monitors.
func lyricsWorkAreaForBounds(bounds LyricsBounds, areas []LyricsBounds) *LyricsBounds {
	var best *LyricsBounds
	distance := math.Inf(1)
	for _, area := range areas {
		fitted, err := fitLyricsBounds(bounds, []LyricsBounds{area})
		if err != nil {
			continue
		}
		dx, dy := float64(fitted.X-bounds.X), float64(fitted.Y-bounds.Y)
		if d := dx*dx + dy*dy; d < distance {
			selected := area
			best, distance = &selected, d
		}
	}
	return best
}

func sameLyricsWorkArea(left, right *LyricsBounds) bool {
	return left == right || (left != nil && right != nil && *left == *right)
}
