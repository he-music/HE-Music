package main

import (
	"errors"
	"testing"
)

type reentrantTaskbar struct {
	enter   func()
	updates int
	clears  int
	closes  int
	fail    bool
}

func (b *reentrantTaskbar) sync(TaskbarState) error {
	b.updates++
	if b.enter != nil {
		enter := b.enter
		b.enter = nil
		enter()
	}
	if b.fail {
		return errors.New("native failure")
	}
	return nil
}
func (b *reentrantTaskbar) clear() error { b.clears++; return nil }
func (b *reentrantTaskbar) close() error { b.closes++; return nil }

func TestTaskbarSyncFenceReentrantRevoke(t *testing.T) {
	backend := &reentrantTaskbar{}
	var c taskbarController
	c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return backend, nil }
	epoch, err := c.begin(1)
	if err != nil {
		t.Fatal(err)
	}
	state := taskbarFixture()
	state.Epoch = epoch
	backend.enter = func() { _ = c.revoke() }
	if err := c.sync(state); !errors.Is(err, errTaskbarSuperseded) {
		t.Fatalf("sync error = %v", err)
	}
	if c.state.Epoch != 0 || c.state.Enabled {
		t.Fatalf("stale sync revived state: %+v", c.state)
	}
}

func TestTaskbarSyncFenceReentrantBeginAndShutdown(t *testing.T) {
	for _, test := range []struct {
		name      string
		enter     func(*taskbarController)
		wantEpoch bool
	}{
		{"begin", func(c *taskbarController) { _, _ = c.begin(1) }, true},
		{"shutdown", func(c *taskbarController) { _ = c.shutdown() }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &reentrantTaskbar{}
			var c taskbarController
			c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return backend, nil }
			epoch, err := c.begin(1)
			if err != nil {
				t.Fatal(err)
			}
			state := taskbarFixture()
			state.Epoch = epoch
			backend.enter = func() { test.enter(&c) }
			if err := c.sync(state); !errors.Is(err, errTaskbarSuperseded) {
				t.Fatalf("sync error = %v", err)
			}
			if (c.state.Epoch != 0) != test.wantEpoch {
				t.Fatalf("unexpected owner after reentry: %+v", c.state)
			}
		})
	}
}

func TestTaskbarSyncFenceReentrantBeginOnErrorKeepsNewOwner(t *testing.T) {
	backend := &reentrantTaskbar{fail: true}
	var c taskbarController
	c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return backend, nil }
	epoch, err := c.begin(1)
	if err != nil {
		t.Fatal(err)
	}
	state := taskbarFixture()
	state.Epoch = epoch
	backend.enter = func() { _, _ = c.begin(1) }
	if err := c.sync(state); !errors.Is(err, errTaskbarSuperseded) {
		t.Fatalf("sync error = %v", err)
	}
	if c.state.Epoch == 0 || c.state.Epoch == epoch && c.state.Enabled {
		t.Fatalf("old error changed owner: %+v", c.state)
	}
}
