package main

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

var desktopUpdatesChanged = mygo.NewEvent[UpdatesEvent]("desktop:updates")

var desktopUpdates = newUpdates(
	updatesSDKDriver{},
	(&updatesMainDispatcher{}).post,
	func(ctx context.Context) bool {
		l := desktopLifecycle
		return os.Getenv("MYGO_GENERATE") == "" && l.main != nil && !l.main.IsDestroyed() &&
			!l.state.cleaned && !l.state.quitting && l.state.owns(ctx) &&
			sameLifecyclePage(l.main.Page(), mygo.CallerPage(ctx))
	},
	func(ctx context.Context, event UpdatesEvent) error {
		return desktopUpdatesChanged.EmitPage(mygo.CallerPage(ctx), event)
	},
)

// Registration does not probe Enabled (which writes a temporary installation
// directory), start a checker, inspect AppData, or register the updater plugin.
func init() { mygo.Bind(desktopUpdates) }

type updatesSDKDriver struct{}

func (updatesSDKDriver) check(ctx context.Context) (updatesCandidate, error) {
	if os.Getenv("MYGO_GENERATE") != "" || mygo.IsDev() {
		return nil, errUpdatesUnavailable
	}
	up, err := mygo.Updater.Check(ctx)
	if errors.Is(err, mygo.ErrUpdatesDisabled) {
		return nil, errUpdatesUnavailable
	}
	if err != nil || up == nil {
		return nil, err
	}
	return updatesSDKCandidate{update: up}, nil
}

type updatesSDKCandidate struct{ update *mygo.Update }

func (c updatesSDKCandidate) metadata() (string, string, string) {
	date := ""
	if !c.update.Date.IsZero() {
		date = c.update.Date.Format(time.RFC3339)
	}
	return c.update.Version, c.update.Notes, date
}

func (c updatesSDKCandidate) install(ctx context.Context) error {
	return c.update.Install(ctx, nil)
}

// RunOnMain is synchronous in this SDK. A lazy FIFO worker performs that wait,
// so binding methods never wait for the UI thread and commands retain order.
// No goroutine is started by registration or by CLI binding generation.
type updatesMainDispatcher struct {
	mu      sync.Mutex
	queue   []func()
	running bool
}

func (d *updatesMainDispatcher) post(fn func()) {
	d.mu.Lock()
	d.queue = append(d.queue, fn)
	if !d.running {
		d.running = true
		go d.drain()
	}
	d.mu.Unlock()
}

func (d *updatesMainDispatcher) drain() {
	for {
		d.mu.Lock()
		if len(d.queue) == 0 {
			d.running = false
			d.mu.Unlock()
			return
		}
		fn := d.queue[0]
		d.queue[0] = nil
		d.queue = d.queue[1:]
		d.mu.Unlock()
		mygo.RunOnMain(fn)
	}
}
