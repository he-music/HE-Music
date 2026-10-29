package main

import (
	"context"
	"errors"
	"time"

	"github.com/egoist/mygo"
)

func (l *DesktopLyrics) SetUnlockRegion(ctx context.Context, epoch uint64, region LyricsUnlockRegion) error {
	return l.call(ctx, epoch, true, func() error {
		if !l.isChild(ctx) || !l.state.attached || !validLyricsUnlockRegion(region, l.state.window.Bounds) {
			return errors.New("desktop lyrics unlock region is invalid")
		}
		l.unlockRegion = &region
		return nil
	})
}

func (l *DesktopLyrics) stopHoverUnlock() {
	if l.hoverWatcher != nil {
		l.hoverWatcher.stop()
		l.hoverWatcher = nil
	}
}

func (l *DesktopLyrics) startHoverUnlock() {
	l.stopHoverUnlock()
	win, generation := l.win, l.state.generation
	if win == nil || !l.state.window.Locked {
		return
	}
	watcher := &lyricsHoverWatcher{
		current: func() bool {
			return l.win == win && !win.IsDestroyed() && l.state.current(generation) &&
				l.state.attached && l.state.window.Visible && l.state.window.Locked
		},
		sample: func() (LyricsBounds, int, int, *LyricsUnlockRegion) {
			point := mygo.Screen.CursorScreenPoint()
			return LyricsBounds(win.Bounds()), point.X, point.Y, l.unlockRegion
		},
		schedule: func(tick func()) func() {
			// The SDK has no Electron-style mouse-event forwarding. Sample only
			// while visible and locked, with at most one pending main-thread tick.
			timer := time.AfterFunc(75*time.Millisecond, func() { mygo.RunOnMain(tick) })
			return func() { timer.Stop() }
		},
		onHover: func(hovered bool) {
			if l.state.window.HoverUnlock == hovered {
				return
			}
			l.state.window.HoverUnlock = hovered
			l.state.window.Revision++
			l.emitWindow()
		},
		onInput: func(interactive bool) {
			if l.win == win && !win.IsDestroyed() {
				win.SetIgnoreMouseEvents(l.state.window.Locked && !interactive)
			}
		},
	}
	l.hoverWatcher = watcher
	watcher.start()
}
