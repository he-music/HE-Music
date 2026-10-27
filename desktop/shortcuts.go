package main

import (
	"context"
	"errors"
	"os"
	"runtime"

	"github.com/egoist/mygo"
)

var (
	desktopShortcutAction = mygo.NewEvent[ShortcutEvent]("desktop:shortcut-action")
	desktopShortcuts      = &GlobalShortcuts{}
)

// GlobalShortcuts shares DesktopLifecycle's explicitly attached main Page and
// Ready context. Tray creation is deliberately not part of shortcut eligibility.
type GlobalShortcuts struct {
	state shortcutState
}

func init() {
	desktopShortcuts.state = shortcutState{
		backend: mygo.GlobalShortcut,
		goos:    runtime.GOOS,
		valid: func(ctx context.Context) bool {
			l := desktopLifecycle
			return os.Getenv("MYGO_GENERATE") == "" && l.main != nil && !l.main.IsDestroyed() &&
				l.state.owns(ctx) && sameLifecyclePage(l.main.Page(), mygo.CallerPage(ctx))
		},
		emit: func(event ShortcutEvent) {
			// The target is the claimed main page, even when hidden/unfocused.
			if err := desktopShortcutAction.EmitPage(desktopLifecycle.main.Page(), event); err != nil {
				desktopShortcuts.revoke()
			}
		},
	}
	mygo.Bind(desktopShortcuts)
}

// Replace claims with generation=0 only when no shortcut session exists. Every
// subsequent operation must supply the last returned generation. Callers must
// serialize mutations and discard already queued events from older generations.
func (s *GlobalShortcuts) Replace(ctx context.Context, generation uint64, enabled bool, bindings []ShortcutBinding) (ShortcutStatus, error) {
	var status ShortcutStatus
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		status, err = s.state.replace(ctx, generation, enabled, bindings)
		return err
	})
	return status, err
}

// Suspend releases this service's shortcuts while retaining the latest config.
func (s *GlobalShortcuts) Suspend(ctx context.Context, generation uint64) (ShortcutStatus, error) {
	return s.setSuspended(ctx, generation, true)
}

// Resume retries registration, returning each action's current system failure.
func (s *GlobalShortcuts) Resume(ctx context.Context, generation uint64) (ShortcutStatus, error) {
	return s.setSuspended(ctx, generation, false)
}

func (s *GlobalShortcuts) setSuspended(ctx context.Context, generation uint64, suspended bool) (ShortcutStatus, error) {
	var status ShortcutStatus
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		status, err = s.state.setSuspended(ctx, generation, suspended)
		return err
	})
	return status, err
}

// Check validates syntax and checks this service's successful registrations only.
// It cannot detect another app's reservation; Replace/Resume return that failure.
func (s *GlobalShortcuts) Check(ctx context.Context, generation uint64, accelerator string) (ShortcutCheck, error) {
	var result ShortcutCheck
	err := desktopLifecycle.call(ctx, true, func() error {
		if !s.state.owns(ctx, generation) {
			return errors.New("shortcut owner or generation is no longer active")
		}
		result = s.state.check(accelerator)
		return nil
	})
	return result, err
}

// Teardown cannot release a newer session, even when the old call arrives late.
// A repeated teardown for the just-released session succeeds without native work.
func (s *GlobalShortcuts) Teardown(ctx context.Context, generation uint64) error {
	return desktopLifecycle.call(ctx, true, func() error {
		return s.state.teardown(ctx, generation)
	})
}

// Called only on the main thread by lifecycle revoke, teardown and quit hooks.
func (s *GlobalShortcuts) revoke() {
	s.state.revoke()
}
