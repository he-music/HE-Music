package main

import (
	"context"
	"os"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

// Updates exposes only the official updater's public state and entry points.
// Downloads, cancellation, skipped versions and installation belong to the plugin.
type Updates struct {
	revision   uint64
	installed  bool
	configured bool
}

type UpdatesState struct {
	Revision         uint64 `json:"revision"`
	AvailableVersion string `json:"availableVersion"`
	Installed        bool   `json:"installed"`
}

var (
	desktopUpdates        = &Updates{}
	desktopUpdatesChanged = mygo.NewEvent[UpdatesState]("desktop:updates")
)

func init() { mygo.Bind(desktopUpdates) }

// Register after main's WhenReady callback so legacy preferences are migrated
// before the plugin starts reading updater.json. Binding generation never starts it.
func configureDesktopUpdates() {
	mygo.Use(updater.New(updater.Options{
		Interval:               6 * time.Hour,
		DisableAutomaticChecks: true,
	}))
	desktopUpdates.configured = true
	updater.OnChange(desktopUpdates.publish)
	updater.OnInstalled(func() {
		desktopUpdates.installed = true
		desktopUpdates.publish()
	})
}

func (u *Updates) snapshot() UpdatesState {
	if !u.configured {
		return UpdatesState{}
	}
	return UpdatesState{
		Revision: u.revision, AvailableVersion: updater.AvailableVersion(), Installed: u.installed,
	}
}

func (u *Updates) publish() {
	u.revision++
	l := desktopLifecycle
	if l.main != nil && !l.main.IsDestroyed() && l.state.ready() && !l.state.quitting {
		_ = desktopUpdatesChanged.EmitPage(l.main.Page(), u.snapshot())
	}
}

func (u *Updates) GetState(ctx context.Context) (UpdatesState, error) {
	var state UpdatesState
	err := desktopLifecycle.call(ctx, true, func() error {
		state = u.snapshot()
		return nil
	})
	return state, err
}

func (u *Updates) Configure(ctx context.Context, automaticChecks bool) error {
	return desktopLifecycle.call(ctx, true, func() error {
		if u.configured && updater.AutomaticChecks() != automaticChecks {
			updater.SetAutomaticChecks(automaticChecks)
		}
		return nil
	})
}

func (u *Updates) Check(ctx context.Context) error {
	return desktopLifecycle.call(ctx, true, func() error {
		if u.configured && os.Getenv("MYGO_GENERATE") == "" {
			updater.CheckForUpdates()
		}
		return nil
	})
}
