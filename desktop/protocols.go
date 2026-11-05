package main

import (
	"context"
	"errors"
	"os"
	"runtime"

	"github.com/egoist/mygo"
)

var (
	desktopProtocolIntent = mygo.NewEvent[ProtocolIntent]("desktop:protocol-intent")
	desktopProtocols      = &Protocols{state: protocolState{backend: newNativeProtocolBackend(), goos: runtime.GOOS}}
)

type Protocols struct{ state protocolState }

func init() { mygo.Bind(desktopProtocols) }

// installProtocolHooks must run before App.Run. A false result means main must
// exit without creating a window or calling Run. SDK alone forwards launch URLs.
func installProtocolHooks() (bool, func()) {
	if os.Getenv("MYGO_GENERATE") != "" {
		return true, func() {}
	}
	if !mygo.App.RequestSingleInstanceLock() {
		return false, func() {}
	}
	off := mygo.App.OnOpenURL(func(raw string) {
		desktopProtocols.state.receive(raw)
		desktopProtocols.deliver(desktopProtocols.state.drain())
	})
	return true, off
}

func (p *Protocols) Begin(ctx context.Context) (ProtocolSession, error) {
	result := ProtocolSession{}
	err := desktopLifecycle.call(ctx, true, func() error {
		epoch, err := p.state.begin(ctx)
		result.Epoch = epoch
		return err
	})
	return result, err
}

func (p *Protocols) Sync(ctx context.Context, epoch uint64, schemes []string) (ProtocolStatus, error) {
	result := ProtocolStatus{}
	err := desktopLifecycle.call(ctx, true, func() error {
		var events []ProtocolIntent
		var err error
		result, events, err = p.state.sync(ctx, epoch, schemes)
		if err == nil {
			p.deliver(events)
		}
		return err
	})
	return result, err
}

func (p *Protocols) Teardown(ctx context.Context, epoch uint64) error {
	return desktopLifecycle.call(ctx, true, func() error {
		if !p.state.owns(ctx, epoch) {
			return errors.New("protocol owner expired")
		}
		p.revoke()
		return nil
	})
}

func (p *Protocols) deliver(events []ProtocolIntent) {
	for _, event := range events {
		l := desktopLifecycle
		if p.state.owner == nil || !p.state.owns(l.state.owner, event.Epoch) || !l.state.owns(p.state.owner) {
			p.revoke()
			return
		}
		if err := desktopProtocolIntent.EmitPage(l.main.Page(), event); err != nil {
			p.revoke()
			return
		}
	}
}

// Called by the parent's lifecycle revoke path on the main thread.
func (p *Protocols) revoke() { p.state.revoke() }
