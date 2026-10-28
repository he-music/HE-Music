package main

import (
	"context"
	"errors"
	"log"
	"os"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	desktopassets "github.com/he-music/HE-Music"
)

var (
	desktopTrayAction     = mygo.NewEvent[TrayRequest]("desktop:tray-action")
	desktopCloseRequested = mygo.NewEvent[CloseRequested]("desktop:close-requested")
	desktopLifecycle      = &DesktopLifecycle{}
)

// DesktopLifecycle owns exactly the window explicitly attached by main/probe.
// Every bound call is checked against both that top-level page and its context.
type DesktopLifecycle struct {
	main        *mygo.Window
	state       lifecycleState
	tray        *mygo.Tray
	menu        *mygo.Menu
	menuState   trayMenuState
	traySession traySession
	listeners   []func()
	stopOwner   func() bool
	promptTimer *time.Timer
}

func init() {
	mygo.Bind(desktopLifecycle)
}

// attachMainWindow is called from WhenReady, never from service initialization.
// Probe windows pass false: no tray is created and their Close cannot be hidden.
func (l *DesktopLifecycle) attachMainWindow(win *mygo.Window, enableTray bool) {
	if win == nil || l.main != nil || l.state.cleaned || os.Getenv("MYGO_GENERATE") != "" {
		return
	}
	l.main = win
	desktopLyrics.attachMainWindow(win)
	l.listeners = append(l.listeners,
		win.OnClose(l.onClose),
		win.OnClosed(l.cleanup),
		win.Page().OnDidNavigate(func(string) { l.revoke() }),
		win.Page().OnDidFailLoad(func(*mygo.LoadError) { l.revoke() }),
		win.Page().OnRenderProcessGone(func(string) { l.revoke() }),
		mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) {
			desktopShortcuts.revoke()
			desktopSystemMedia.revoke()
			desktopFiles.revoke()
			desktopUpdates.revoke()
			desktopLyrics.revoke()
			l.state.beginQuit()
			l.stopPrompt()
		}),
		mygo.App.OnWillQuit(func(*mygo.QuitEvent) { l.cleanup() }),
		mygo.App.OnQuit(l.cleanup),
		mygo.App.OnActivate(func(bool) { l.show() }),
	)
	if enableTray {
		l.createTray()
	}
}

// Ready must be called only after both typed event subscriptions are installed.
// Subscribe/Ready/Teardown belong to the application shell, not an account view.
func (l *DesktopLifecycle) Ready(ctx context.Context, config LifecycleConfig) (LifecycleStatus, error) {
	status := LifecycleStatus{}
	err := l.call(ctx, false, func() error {
		if err := validateLifecycleConfig(config); err != nil {
			return err
		}
		l.revoke()
		epoch, err := l.traySession.begin()
		if err != nil {
			return err
		}
		status.Epoch = epoch
		l.state.owner = ctx
		l.state.config = config
		l.stopOwner = context.AfterFunc(ctx, func() {
			mygo.RunOnMain(func() {
				if l.state.owner == ctx {
					l.revoke()
				}
			})
		})
		status.TrayAvailable = l.state.tray
		l.updateMenu()
		return nil
	})
	return status, err
}

func (l *DesktopLifecycle) SyncConfig(ctx context.Context, config LifecycleConfig) error {
	return l.call(ctx, true, func() error {
		if err := validateLifecycleConfig(config); err != nil {
			return err
		}
		l.state.config = config
		l.updateMenu()
		return nil
	})
}

// SyncPlayback is for play status/song changes only; never send playback clocks.
func (l *DesktopLifecycle) SyncPlayback(ctx context.Context, playback TrayPlaybackState) error {
	return l.call(ctx, true, func() error {
		if err := l.traySession.sync(playback); err != nil {
			return err
		}
		l.updateMenu()
		return nil
	})
}

// Teardown invalidates readiness before the frontend removes its subscriptions.
// A hidden window is shown so a failed/unmounted frontend cannot strand the app.
func (l *DesktopLifecycle) Teardown(ctx context.Context) error {
	return l.call(ctx, true, func() error { l.revoke(); return nil })
}

func (l *DesktopLifecycle) Show(ctx context.Context) error {
	return l.call(ctx, true, func() error { l.show(); return nil })
}

func (l *DesktopLifecycle) Hide(ctx context.Context) error {
	return l.call(ctx, true, l.hide)
}

// Quit bypasses close requests, including an already displayed confirmation.
func (l *DesktopLifecycle) Quit(ctx context.Context) error {
	return l.call(ctx, true, func() error { l.quit(); return nil })
}

// AcknowledgeClose runs once the confirmation UI is shown, before awaiting user input.
// If no subscriber acknowledges within five seconds, the native close proceeds.
func (l *DesktopLifecycle) AcknowledgeClose(ctx context.Context, requestID uint64) error {
	return l.call(ctx, true, func() error {
		if !l.state.acknowledge(requestID) {
			return errors.New("close request is no longer active")
		}
		l.stopPrompt()
		return nil
	})
}

func (l *DesktopLifecycle) ResolveClose(ctx context.Context, requestID uint64, resolution CloseResolution) error {
	return l.call(ctx, true, func() error {
		if !l.state.matchesRequest(requestID) || !l.state.acknowledged {
			return errors.New("close request is no longer active")
		}
		switch resolution {
		case CloseCancel:
			l.state.clearRequest()
		case CloseHide:
			if err := l.hide(); err != nil {
				return err
			}
			l.state.clearRequest()
		case CloseExit:
			l.quit()
		default:
			return errors.New("invalid close resolution")
		}
		return nil
	})
}

func validateLifecycleConfig(config LifecycleConfig) error {
	if config.CloseAppMethod != CloseAppExit && config.CloseAppMethod != CloseAppHide {
		return errors.New("closeAppMethod must be exit or hide")
	}
	return nil
}

func (l *DesktopLifecycle) call(ctx context.Context, ready bool, fn func() error) error {
	err := errors.New("desktop lifecycle unavailable")
	mygo.RunOnMain(func() {
		if l.main == nil || l.main.IsDestroyed() || l.state.cleaned || l.state.quitting || ctx.Err() != nil ||
			!sameLifecyclePage(l.main.Page(), mygo.CallerPage(ctx)) || (ready && !l.state.owns(ctx)) {
			return
		}
		err = fn()
	})
	return err
}

func sameLifecyclePage(main, caller *mygo.Page) bool {
	return main != nil && main == caller
}

func (l *DesktopLifecycle) onClose(event *mygo.CloseEvent) {
	switch l.state.closeDecision() {
	case closeHide:
		if l.hide() == nil {
			event.PreventDefault()
		}
	case closePrompt:
		if l.state.pending != 0 {
			event.PreventDefault()
			return
		}
		requestID := l.state.requestClose()
		if err := desktopCloseRequested.EmitPage(l.main.Page(), CloseRequested{RequestID: requestID}); err != nil {
			l.revoke()
			return
		}
		event.PreventDefault()
		l.promptTimer = time.AfterFunc(5*time.Second, func() {
			mygo.RunOnMain(func() {
				if l.state.expireRequest(requestID) {
					l.revoke()
					if l.main != nil {
						l.main.Close()
					}
				}
			})
		})
	}
}

func (l *DesktopLifecycle) show() {
	if l.main == nil || l.main.IsDestroyed() || l.state.quitting {
		return
	}
	if l.main.IsMinimized() {
		l.main.Restore()
	}
	l.main.Show()
	l.main.Focus()
}

func (l *DesktopLifecycle) hide() error {
	if !l.state.ready() || !l.state.tray || l.main == nil || l.main.IsDestroyed() {
		return errors.New("hiding requires a ready main page and an available tray")
	}
	l.main.Hide()
	return nil
}

func (l *DesktopLifecycle) quit() {
	l.state.beginQuit()
	l.stopPrompt()
	mygo.App.Quit()
}

func (l *DesktopLifecycle) stopPrompt() {
	if l.promptTimer != nil {
		l.promptTimer.Stop()
		l.promptTimer = nil
	}
}

func (l *DesktopLifecycle) revoke() {
	desktopShortcuts.revoke()
	desktopSystemMedia.revoke()
	desktopFiles.revoke()
	desktopUpdates.revoke()
	desktopLyrics.revoke()
	l.state.invalidate()
	l.stopPrompt()
	if l.stopOwner != nil {
		l.stopOwner()
		l.stopOwner = nil
	}
	l.traySession.revoke()
	l.updateMenu()
	if l.main != nil && !l.main.IsVisible() {
		l.show()
	}
}

func (l *DesktopLifecycle) cleanup() {
	if !l.state.cleanup() {
		return
	}
	desktopShortcuts.revoke()
	desktopSystemMedia.revoke()
	desktopFiles.revoke()
	desktopUpdates.revoke()
	desktopLyrics.revoke()
	l.traySession.revoke()
	l.stopPrompt()
	if l.stopOwner != nil {
		l.stopOwner()
		l.stopOwner = nil
	}
	l.main = nil
	l.menu = nil
	for _, off := range l.listeners {
		off()
	}
	l.listeners = nil
	if l.tray != nil {
		l.tray.Destroy()
		l.tray = nil
	}
}

func (l *DesktopLifecycle) createTray() {
	// Set the icon separately: this mygo version can leak its internal native
	// tray when NewTray's Icon setter fails before it returns the Tray handle.
	tray, err := mygo.NewTray(mygo.TrayOptions{ID: "he-music-main", ToolTip: "HE-Music"})
	if err != nil {
		log.Print("desktop tray unavailable; native close remains enabled")
		return
	}
	icon, template := desktopassets.TrayColor, false
	if runtime.GOOS == "darwin" {
		icon, template = desktopTrayTemplateIcon(), true
	}
	if err = tray.SetIcon(icon, template); err != nil {
		tray.Destroy()
		log.Print("desktop tray icon unavailable; native close remains enabled")
		return
	}
	l.tray = tray
	l.state.tray = true
	l.updateMenu()
}

func (l *DesktopLifecycle) updateMenu() {
	if l.tray == nil {
		return
	}
	playback := l.traySession.snapshot()
	state := trayMenuState{
		playback:        playback,
		labels:          l.state.config.Labels,
		ready:           l.state.ready(),
		hasSong:         playback.HasSong,
		playing:         playback.Playing,
		canHide:         l.state.ready() && l.state.tray,
		lyricsAvailable: l.lyricsReady(),
		lyricsVisible:   desktopLyrics.state.window.Visible,
		lyricsPending:   desktopLyrics.state.window.Pending,
		lyricsLocked:    desktopLyrics.state.window.Locked,
	}
	if l.menu != nil && l.menuState == state {
		return
	}
	l.menu = mygo.NewMenu(buildTrayMenuItems(state, func(command trayMenuCommand) {
		if !trayMenuCommandCurrent(state, l.menuState, command) {
			return
		}
		l.dispatchTrayCommand(command, state.playback)
	}))
	l.menuState = state
	l.tray.SetMenu(l.menu)
}
