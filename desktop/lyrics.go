package main

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/egoist/mygo"
)

var (
	desktopLyrics         = &DesktopLyrics{}
	desktopLyricsWindow   = mygo.NewEvent[LyricsWindowState]("desktop:lyrics-window")
	desktopLyricsSnapshot = mygo.NewEvent[LyricsSnapshot]("desktop:lyrics-snapshot")
	desktopLyricsClock    = mygo.NewEvent[LyricsClock]("desktop:lyrics-clock")
	desktopLyricsCommand  = mygo.NewEvent[LyricsCommand]("desktop:lyrics-command")
)

// DesktopLyrics owns an independent web window with a native external unlock path.
// It never owns audio, claims lifecycle readiness, writes settings, or accepts arbitrary IPC.
type DesktopLyrics struct {
	main      *mygo.Window
	win       *mygo.Window
	state     lyricsState
	listeners []func()
	timer     *time.Timer
	stopChild func() bool
}

func init() { mygo.Bind(desktopLyrics) }

func (l *DesktopLyrics) attachMainWindow(win *mygo.Window) {
	if l.main == nil && os.Getenv("MYGO_GENERATE") == "" {
		l.main = win
	}
}

func (l *DesktopLyrics) Begin(ctx context.Context) (LyricsSession, error) {
	result := LyricsSession{}
	if os.Getenv("MYGO_GENERATE") != "" {
		return result, errLyricsOwner
	}
	err := desktopLifecycle.call(ctx, true, func() error {
		if l.main == nil || l.main != desktopLifecycle.main {
			return errLyricsOwner
		}
		l.revoke()
		var err error
		result, err = l.state.begin(ctx)
		desktopLifecycle.updateMenu()
		return err
	})
	return result, err
}

// SetVisible returns immediately with Pending=true on first creation. Only a
// later window event with Visible=true confirms ready-to-show AND Attach.
func (l *DesktopLyrics) SetVisible(ctx context.Context, epoch uint64, visible bool) (LyricsWindowState, error) {
	result := LyricsWindowState{}
	err := l.call(ctx, epoch, false, func() error {
		if !visible {
			l.closeWindow(l.state.generation, "")
		} else if l.win == nil {
			if err := l.createWindow(); err != nil {
				result = l.state.window
				return err
			}
		}
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) Close(ctx context.Context, epoch uint64) (LyricsWindowState, error) {
	result := LyricsWindowState{}
	err := l.call(ctx, epoch, true, func() error {
		l.closeWindow(l.state.generation, "")
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) SetLocked(ctx context.Context, epoch uint64, locked bool) (LyricsWindowState, error) {
	result := LyricsWindowState{}
	err := l.call(ctx, epoch, true, func() error {
		if err := l.setLocked(locked); err != nil {
			return err
		}
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) setLocked(locked bool) error {
	if l.win == nil || l.win.IsDestroyed() {
		if locked {
			return errors.New("desktop lyrics window is closed")
		}
		return l.state.setLocked(false, false)
	}
	externalUnlock := desktopLifecycle.tray != nil && desktopLifecycle.state.tray &&
		desktopLifecycle.state.owns(l.state.owner)
	if err := l.state.setLocked(locked, externalUnlock); err != nil {
		return err
	}
	// Install the native unlock action before making the web window click-through.
	desktopLifecycle.updateMenu()
	if locked && desktopLifecycle.menu == nil {
		_ = l.state.setLocked(false, false)
		return errors.New("desktop lyrics unlock menu unavailable")
	}
	l.win.SetMovable(!locked)
	l.win.SetIgnoreMouseEvents(locked)
	l.emitWindow()
	return nil
}

func (l *DesktopLyrics) PublishSnapshot(ctx context.Context, snapshot LyricsSnapshot) error {
	return l.call(ctx, snapshot.Epoch, false, func() error {
		if err := l.state.publishSnapshot(snapshot); err != nil {
			return err
		}
		if l.state.attached && l.win != nil {
			if err := desktopLyricsSnapshot.EmitPage(l.win.Page(), *l.state.snapshot); err != nil {
				l.closeWindow(l.state.generation, "snapshot-delivery-failed")
				return err
			}
		}
		return nil
	})
}

func (l *DesktopLyrics) PublishClock(ctx context.Context, clock LyricsClock) error {
	return l.call(ctx, clock.Epoch, false, func() error {
		if err := l.state.publishClock(clock); err != nil {
			return err
		}
		if l.state.attached && l.win != nil {
			if err := desktopLyricsClock.EmitPage(l.win.Page(), clock); err != nil {
				l.closeWindow(l.state.generation, "clock-delivery-failed")
				return err
			}
		}
		return nil
	})
}

// Subscribe first, then Attach. CallerPage must be this exact window's Page;
// the main page and other child windows cannot attach or send commands.
func (l *DesktopLyrics) Attach(ctx context.Context) (LyricsAttachment, error) {
	result := LyricsAttachment{}
	err := l.callWithAttach(ctx, 0, true, true, func() error {
		if !l.isChild(ctx) {
			return errLyricsOwner
		}
		generation := l.state.generation
		if !l.state.current(generation) {
			return errLyricsOwner
		}
		l.state.attached = true
		if l.stopChild == nil {
			l.stopChild = context.AfterFunc(ctx, func() {
				mygo.RunOnMain(func() { l.closeWindow(generation, "child-context-ended") })
			})
		}
		l.maybeShow(generation)
		result = l.state.attachment()
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) GetState(ctx context.Context, epoch uint64) (LyricsWindowState, error) {
	result := LyricsWindowState{}
	err := l.call(ctx, epoch, true, func() error {
		l.readBounds()
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) SetBounds(ctx context.Context, epoch uint64, bounds LyricsBounds) (LyricsWindowState, error) {
	result := LyricsWindowState{}
	err := l.call(ctx, epoch, true, func() error {
		if l.win == nil {
			return errors.New("desktop lyrics window is closed")
		}
		if l.state.window.Locked {
			return errors.New("desktop lyrics window is locked")
		}
		fitted, err := fitLyricsBounds(bounds, lyricsWorkAreas())
		if err != nil {
			return err
		}
		l.win.SetBounds(mygo.Rectangle(fitted))
		l.readBounds()
		result = l.state.window
		return nil
	})
	return result, err
}

func (l *DesktopLyrics) Command(ctx context.Context, command LyricsCommand) error {
	return l.call(ctx, command.Epoch, true, func() error {
		if !l.isChild(ctx) || !l.state.attached {
			return errLyricsOwner
		}
		if err := l.state.validateCommand(command); err != nil {
			return err
		}
		if command.Action == LyricsShowMain || command.Action == LyricsOpenSettings {
			desktopLifecycle.show()
		}
		return desktopLyricsCommand.EmitPage(l.main.Page(), command)
	})
}

func (l *DesktopLyrics) Teardown(ctx context.Context, epoch uint64) error {
	return l.call(ctx, epoch, false, func() error { l.revoke(); return nil })
}

func (l *DesktopLyrics) isChild(ctx context.Context) bool {
	return l.win != nil && !l.win.IsDestroyed() && sameLifecyclePage(l.win.Page(), mygo.CallerPage(ctx))
}

func (l *DesktopLyrics) call(ctx context.Context, epoch uint64, childAllowed bool, fn func() error) error {
	return l.callWithAttach(ctx, epoch, childAllowed, false, fn)
}

func (l *DesktopLyrics) callWithAttach(ctx context.Context, epoch uint64, childAllowed, attaching bool, fn func() error) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return errLyricsOwner
	}
	err := errLyricsOwner
	mygo.RunOnMain(func() {
		if l.main == nil || l.main != desktopLifecycle.main || l.main.IsDestroyed() ||
			!desktopLifecycle.state.owns(l.state.owner) {
			return
		}
		main, child := sameLifecyclePage(l.main.Page(), mygo.CallerPage(ctx)), l.isChild(ctx)
		// Attach learns the epoch only after proving exact child identity.
		if attaching && epoch == 0 && child && childAllowed {
			epoch = l.state.epoch
		}
		if err = l.state.authorize(ctx, epoch, main, child, childAllowed); err != nil {
			return
		}
		err = fn()
	})
	return err
}

func lyricsWorkAreas() []LyricsBounds {
	displays := mygo.Screen.Displays()
	areas := make([]LyricsBounds, 0, len(displays))
	for _, display := range displays {
		areas = append(areas, LyricsBounds(display.WorkArea))
	}
	return areas
}

func (l *DesktopLyrics) createWindow() (err error) {
	areas := lyricsWorkAreas()
	bounds := l.state.window.Bounds
	if bounds.X == 0 && bounds.Y == 0 && len(areas) > 0 {
		bounds.X = areas[0].X + (areas[0].Width-bounds.Width)/2
		bounds.Y = areas[0].Y + areas[0].Height - bounds.Height - 24
	}
	bounds, err = fitLyricsBounds(bounds, areas)
	if err != nil {
		return err
	}
	generation := l.state.open()
	// NewWindow reports native creation failure by panic rather than an error.
	defer func() {
		if recover() != nil {
			l.closeWindow(generation, "window-creation-failed")
			err = errors.New("desktop lyrics window creation failed")
		}
	}()
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "HE-Music Desktop Lyrics", URL: "/#/desktop-lyric",
		Width: bounds.Width, Height: bounds.Height, X: bounds.X, Y: bounds.Y,
		MinWidth: 640, MinHeight: 140, MaxWidth: 1400, MaxHeight: 360,
		Hidden: true, Frameless: true, Transparent: true, DisableShadow: true,
		AlwaysOnTop: true, SkipTaskbar: true, Panel: true,
		DisableMinimize: true, DisableMaximize: true, DisableFullScreen: true,
	})
	l.win = win
	if win.IsDestroyed() || win.Page() == nil {
		l.closeWindow(generation, "window-creation-failed")
		return errors.New("desktop lyrics window creation failed")
	}
	l.state.window.Bounds = LyricsBounds(win.Bounds())
	navigated := false
	l.listeners = append(l.listeners,
		win.OnReadyToShow(func() {
			if l.state.current(generation) {
				l.state.ready = true
				l.maybeShow(generation)
			}
		}),
		win.OnClosed(func() { l.closeWindow(generation, "") }),
		win.OnMove(func() {
			if l.state.current(generation) {
				l.readBounds()
			}
		}),
		win.OnResize(func() {
			if l.state.current(generation) {
				l.readBounds()
			}
		}),
		win.Page().OnDidNavigate(func(string) {
			if navigated || l.state.attached {
				l.closeWindow(generation, "child-navigated")
			}
			navigated = true
		}),
		win.Page().OnDidFailLoad(func(*mygo.LoadError) { l.closeWindow(generation, "child-load-failed") }),
		win.Page().OnRenderProcessGone(func(string) { l.closeWindow(generation, "child-render-process-gone") }),
		mygo.Screen.OnDisplaysChanged(func() {
			if !l.state.current(generation) {
				return
			}
			bounds, err := fitLyricsBounds(LyricsBounds(win.Bounds()), lyricsWorkAreas())
			if err != nil {
				l.closeWindow(generation, "display-unavailable")
				return
			}
			win.SetBounds(mygo.Rectangle(bounds))
			l.readBounds()
		}),
	)
	l.timer = time.AfterFunc(10*time.Second, func() {
		mygo.RunOnMain(func() {
			if l.state.current(generation) && l.state.window.Pending {
				l.closeWindow(generation, "attach-timeout")
			}
		})
	})
	l.emitWindow()
	return nil
}

func (l *DesktopLyrics) maybeShow(generation uint64) {
	if l.win == nil || !l.state.showable(generation) {
		return
	}
	l.win.ShowInactive()
	if !l.win.IsVisible() {
		l.closeWindow(generation, "window-show-failed")
		return
	}
	l.state.shown()
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
	l.emitWindow()
}

func (l *DesktopLyrics) readBounds() {
	if l.win != nil && !l.win.IsDestroyed() {
		bounds := LyricsBounds(l.win.Bounds())
		if bounds != l.state.window.Bounds {
			l.state.window.Bounds = bounds
			l.state.window.Revision++
			l.emitWindow()
		}
	}
}

func (l *DesktopLyrics) emitWindow() {
	desktopLifecycle.updateMenu()
	if l.main != nil && !l.main.IsDestroyed() && l.state.owner != nil && l.state.owner.Err() == nil {
		_ = desktopLyricsWindow.EmitPage(l.main.Page(), l.state.window)
	}
	if l.win != nil && !l.win.IsDestroyed() {
		_ = desktopLyricsWindow.EmitPage(l.win.Page(), l.state.window)
	}
}

func (l *DesktopLyrics) closeWindow(generation uint64, failure string) {
	if !l.state.close(generation, failure) {
		return
	}
	l.emitWindow()
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
	if l.stopChild != nil {
		l.stopChild()
		l.stopChild = nil
	}
	win := l.win
	l.win = nil
	for _, off := range l.listeners {
		off()
	}
	l.listeners = nil
	if win != nil && !win.IsDestroyed() {
		win.SetIgnoreMouseEvents(false)
		win.SetMovable(true)
		win.Destroy()
	}
}

// Lifecycle revocation is synchronous and does not wait for renderer replies.
func (l *DesktopLyrics) revoke() {
	l.closeWindow(l.state.generation, "")
	l.state.revoke()
	desktopLifecycle.updateMenu()
}
