package main

import (
	"context"
	"errors"

	"github.com/egoist/mygo"
)

var (
	desktopControlCommand = mygo.NewEvent[ControlCommand]("desktop:control-command")
	desktopControl        = &PlaybackControl{}
)

// PlaybackControl acquires its loopback listener only after the shell subscribes.
// Binding generation neither opens sockets nor touches native resources.
type PlaybackControl struct{ service controlServer }

func init() {
	desktopControl.service.emit = func(ctx context.Context, command ControlCommand) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := errors.New("control dispatch unavailable")
		mygo.RunOnMain(func() {
			l := desktopLifecycle
			if ctx.Err() != nil || !l.state.ready() || l.main == nil || l.main.IsDestroyed() || !desktopControl.service.current(l.state.owner, l.traySession.snapshot().Epoch, command) {
				err = errors.New("stale control dispatch")
				return
			}
			err = desktopControlCommand.EmitPage(l.main.Page(), command)
		})
		return err
	}
	mygo.Bind(desktopControl)
}

// Start runs listener acquisition on the binding goroutine after main-thread
// ownership validation. port=0 selects the legacy 25666 default.
func (c *PlaybackControl) Start(ctx context.Context, port int) (ControlSession, error) {
	var generation uint64
	err := desktopLifecycle.call(ctx, true, func() error {
		c.service.mu.Lock()
		c.service.appVersion = mygo.App.Version()
		c.service.mu.Unlock()
		var err error
		generation, err = c.service.prepare(ctx, desktopLifecycle.traySession.snapshot().Epoch)
		return err
	})
	if err != nil {
		return ControlSession{}, err
	}
	return c.service.start(generation, port)
}

func (c *PlaybackControl) Receipt(ctx context.Context, generation, requestID uint64, applied bool) error {
	return desktopLifecycle.call(ctx, true, func() error { return c.service.receipt(ctx, generation, requestID, applied) })
}

func (c *PlaybackControl) Teardown(ctx context.Context, generation uint64) error {
	return desktopLifecycle.call(ctx, true, func() error {
		c.service.mu.Lock()
		defer c.service.mu.Unlock()
		if !c.service.activeLocked() || c.service.owner != ctx || c.service.generation != generation {
			return errors.New("stale control teardown")
		}
		c.service.closeLocked()
		return nil
	})
}
func (c *PlaybackControl) revoke() { c.service.revoke() }
