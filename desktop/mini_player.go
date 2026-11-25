package main

import (
	"context"
	"errors"
	"time"

	"github.com/egoist/mygo"
)

var (
	desktopMiniPlayer      = &DesktopMiniPlayer{}
	desktopMiniPlayerState = mygo.NewEvent[MiniPlayerView]("desktop:mini-player-state")
	desktopMiniPlayerClose = mygo.NewEvent[MiniPlayerClosed]("desktop:mini-player-closed")
	desktopMiniPlayerInput = mygo.NewEvent[MiniPlayerCommand]("desktop:mini-player-command")
	errMiniPlayerOwner     = errors.New("desktop mini player unavailable for this page")
)

func init() { mygo.Bind(desktopMiniPlayer) }

type MiniPlayerSnapshot struct {
	TrackKey    string `json:"trackKey"`
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	Artwork     string `json:"artwork"`
	Language    string `json:"language"`
	Theme       string `json:"theme"`
	Playing     bool   `json:"playing"`
	CanPrevious bool   `json:"canPrevious"`
	CanNext     bool   `json:"canNext"`
	Favorite    bool   `json:"favorite"`
	CanFavorite bool   `json:"canFavorite"`
}

type MiniPlayerView struct {
	Generation uint64             `json:"generation"`
	Revision   uint64             `json:"revision"`
	Pinned     bool               `json:"pinned"`
	Playback   MiniPlayerSnapshot `json:"playback"`
}

type MiniPlayerAction string

const (
	miniPlayerPrevious MiniPlayerAction = "previous"
	miniPlayerToggle   MiniPlayerAction = "toggle"
	miniPlayerNext     MiniPlayerAction = "next"
	miniPlayerFavorite MiniPlayerAction = "favorite"
	miniPlayerPin      MiniPlayerAction = "pin"
	miniPlayerShowMain MiniPlayerAction = "show-main"
	miniPlayerClose    MiniPlayerAction = "close"
)

type MiniPlayerRequest struct {
	Generation uint64           `json:"generation"`
	Revision   uint64           `json:"revision"`
	Action     MiniPlayerAction `json:"action"`
}

type MiniPlayerCommand struct {
	Generation uint64           `json:"generation"`
	Action     MiniPlayerAction `json:"action"`
	TrackKey   string           `json:"trackKey"`
	Favorite   bool             `json:"favorite"`
}

type MiniPlayerClosed struct {
	Generation uint64 `json:"generation"`
	Failed     bool   `json:"failed"`
}

// All window state is confined to the main thread. The child never owns playback.
type DesktopMiniPlayer struct {
	current    *miniPlayerWindow
	generation uint64
	pinned     bool
}

type miniPlayerWindow struct {
	win                *mygo.Window
	owner              context.Context
	view               MiniPlayerView
	listeners          []func()
	stopChild          func() bool
	timer              *time.Timer
	ready              bool
	attached           bool
	rendered           bool
	minimizeMainOnShow bool
	minimizedMain      bool
}

func (m *DesktopMiniPlayer) Open(ctx context.Context, snapshot MiniPlayerSnapshot, minimizeMain bool) (uint64, error) {
	var generation uint64
	err := desktopLifecycle.call(ctx, true, func() error {
		if current := m.current; current != nil {
			generation = current.view.Generation
			current.minimizeMainOnShow = minimizeMain
			if current.canShow() && current.timer == nil {
				m.showWindow(current)
			}
			return nil
		}
		m.generation++
		generation = m.generation
		current := &miniPlayerWindow{
			owner:              desktopLifecycle.state.owner,
			view:               MiniPlayerView{Generation: generation, Revision: 1, Pinned: m.pinned, Playback: snapshot},
			minimizeMainOnShow: minimizeMain,
		}
		m.current = current
		return m.openWindow(current)
	})
	return generation, err
}

func (m *DesktopMiniPlayer) Publish(ctx context.Context, generation uint64, snapshot MiniPlayerSnapshot) error {
	return desktopLifecycle.call(ctx, true, func() error {
		current := m.current
		if current == nil || current.view.Generation != generation || current.view.Playback == snapshot {
			return nil
		}
		current.view.Playback = snapshot
		return m.sendView(current)
	})
}

func (m *DesktopMiniPlayer) Attach(ctx context.Context) (MiniPlayerView, error) {
	var result MiniPlayerView
	err := m.callChild(ctx, func(current *miniPlayerWindow) error {
		if !current.attached {
			current.attached = true
			current.stopChild = context.AfterFunc(ctx, func() {
				mygo.RunOnMain(func() { m.closeWindow(current, false) })
			})
		}
		result = current.view
		return nil
	})
	return result, err
}

// Rendered confirms the child applied the initial snapshot to its DOM.
func (m *DesktopMiniPlayer) Rendered(ctx context.Context, generation uint64) error {
	return m.callChild(ctx, func(current *miniPlayerWindow) error {
		if !current.attached || current.view.Generation != generation {
			return errMiniPlayerOwner
		}
		current.rendered = true
		m.maybeShow(current)
		return nil
	})
}

func (m *DesktopMiniPlayer) Command(ctx context.Context, request MiniPlayerRequest) error {
	return m.callChild(ctx, func(current *miniPlayerWindow) error {
		if !current.canShow() || request.Generation != current.view.Generation {
			return errMiniPlayerOwner
		}
		switch request.Action {
		case miniPlayerClose:
			m.closeWindow(current, false)
		case miniPlayerPin:
			m.pinned = !current.view.Pinned
			// GTK window managers may apply the requested level asynchronously.
			current.win.SetAlwaysOnTop(m.pinned)
			current.view.Pinned = m.pinned
			return m.sendView(current)
		case miniPlayerShowMain:
			desktopLifecycle.show()
		default:
			command, ok := current.view.playbackCommand(request)
			if !ok {
				// The song or its capabilities may have changed since the user clicked.
				return nil
			}
			return desktopMiniPlayerInput.EmitPage(desktopLifecycle.main.Page(), command)
		}
		return nil
	})
}

func (v MiniPlayerView) playbackCommand(request MiniPlayerRequest) (MiniPlayerCommand, bool) {
	if v.Generation != request.Generation || v.Revision != request.Revision || v.Playback.TrackKey == "" {
		return MiniPlayerCommand{}, false
	}
	command := MiniPlayerCommand{Generation: v.Generation, Action: request.Action, TrackKey: v.Playback.TrackKey}
	switch request.Action {
	case miniPlayerToggle:
	case miniPlayerNext:
		if !v.Playback.CanNext {
			return MiniPlayerCommand{}, false
		}
	case miniPlayerPrevious:
		if !v.Playback.CanPrevious {
			return MiniPlayerCommand{}, false
		}
	case miniPlayerFavorite:
		if !v.Playback.CanFavorite {
			return MiniPlayerCommand{}, false
		}
		command.Favorite = !v.Playback.Favorite
	default:
		return MiniPlayerCommand{}, false
	}
	return command, true
}

func (m *DesktopMiniPlayer) callChild(ctx context.Context, fn func(*miniPlayerWindow) error) error {
	err := errMiniPlayerOwner
	mygo.RunOnMain(func() {
		current := m.current
		if current != nil && current.win != nil && !current.win.IsDestroyed() && ctx.Err() == nil &&
			desktopLifecycle.state.owns(current.owner) && sameLifecyclePage(current.win.Page(), mygo.CallerPage(ctx)) {
			err = fn(current)
		}
	})
	return err
}

func (m *DesktopMiniPlayer) openWindow(current *miniPlayerWindow) (err error) {
	const width, height = 356, 92
	defer func() {
		if recover() != nil {
			m.closeWindow(current, false)
			err = errors.New("desktop mini player window creation failed")
		}
	}()
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "HE-Music", Width: width, Height: height, StateKey: "mini-player",
		Hidden: true, Frameless: true, CornerRadius: 14, AlwaysOnTop: m.pinned,
		BackgroundColor: miniPlayerBackground(current.view.Playback.Theme),
		SkipTaskbar:     true, DisableResize: true, DisableMinimize: true,
		DisableMaximize: true, DisableFullScreen: true,
	})
	current.win = win
	page := win.Page()
	if win.IsDestroyed() || page == nil {
		m.closeWindow(current, false)
		return errors.New("desktop mini player window creation failed")
	}
	win.SetSize(width, height)
	navigated := false
	current.listeners = append(current.listeners,
		desktopLifecycle.main.OnRestore(func() { current.minimizedMain = false }),
		page.OnContextMenu(localizeNativeContextMenu),
		page.OnWillNavigate(func(event *mygo.NavigateEvent) { event.PreventDefault() }),
		win.OnReadyToShow(func() {
			current.ready = true
			m.maybeShow(current)
		}),
		win.OnClosed(func() { m.closeWindow(current, false) }),
		page.OnDidNavigate(func(string) {
			if navigated || current.attached {
				m.closeWindow(current, true)
			}
			navigated = true
		}),
		page.OnDidFailLoad(func(*mygo.LoadError) { m.closeWindow(current, true) }),
		page.OnRenderProcessGone(func(string) { m.closeWindow(current, true) }),
	)
	current.timer = time.AfterFunc(10*time.Second, func() {
		mygo.RunOnMain(func() {
			if current.timer != nil {
				m.closeWindow(current, true)
			}
		})
	})
	if err := page.LoadURL("/#/mini-player"); err != nil {
		m.closeWindow(current, false)
		return err
	}
	return nil
}

func miniPlayerBackground(theme string) string {
	switch theme {
	case "light":
		return "#f7f8fc"
	case "dark":
		return "#191a1f"
	default:
		return "light-dark(#f7f8fc, #191a1f)"
	}
}

func (w *miniPlayerWindow) canShow() bool { return w.ready && w.attached && w.rendered }

func (m *DesktopMiniPlayer) maybeShow(current *miniPlayerWindow) {
	if m.current != current || !current.canShow() || current.timer == nil {
		return
	}
	current.timer.Stop()
	current.timer = nil
	m.showWindow(current)
}

func (m *DesktopMiniPlayer) showWindow(current *miniPlayerWindow) {
	current.win.Show()
	if !current.win.IsVisible() {
		m.closeWindow(current, true)
		return
	}
	main := desktopLifecycle.main
	if current.minimizeMainOnShow && m.current == current && desktopLifecycle.state.owns(current.owner) &&
		main != nil && !main.IsDestroyed() && main.IsVisible() && !main.IsMinimized() &&
		main.IsMinimizable() && !main.IsFullScreen() {
		current.minimizedMain = true
		main.Minimize()
	}
}

func (m *DesktopMiniPlayer) sendView(current *miniPlayerWindow) error {
	current.view.Revision++
	if !current.attached {
		return nil
	}
	if err := desktopMiniPlayerState.EmitPage(current.win.Page(), current.view); err != nil {
		m.closeWindow(current, true)
		return err
	}
	return nil
}

func (m *DesktopMiniPlayer) closeWindow(current *miniPlayerWindow, failed bool) {
	if current == nil || m.current != current {
		return
	}
	m.current = nil
	if current.timer != nil {
		current.timer.Stop()
		current.timer = nil
	}
	if current.stopChild != nil {
		current.stopChild()
	}
	for _, off := range current.listeners {
		off()
	}
	if current.win != nil && !current.win.IsDestroyed() {
		current.win.Destroy()
	}
	if desktopLifecycle.state.owns(current.owner) && desktopLifecycle.main != nil && !desktopLifecycle.main.IsDestroyed() {
		if current.minimizedMain && desktopLifecycle.main.IsMinimized() {
			desktopLifecycle.show()
		}
		_ = desktopMiniPlayerClose.EmitPage(desktopLifecycle.main.Page(), MiniPlayerClosed{
			Generation: current.view.Generation, Failed: failed,
		})
	}
}

func (m *DesktopMiniPlayer) revoke() {
	if current := m.current; current != nil {
		current.minimizedMain = false
		m.closeWindow(current, false)
	}
}
