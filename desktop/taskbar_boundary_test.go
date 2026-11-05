package main

import (
	"errors"
	"testing"
)

type boundaryTaskbar struct {
	clearEnter     func()
	syncEnter      func()
	failSync       bool
	clears, closes int
}

func (b *boundaryTaskbar) sync(TaskbarState) error {
	if b.syncEnter != nil {
		enter := b.syncEnter
		b.syncEnter = nil
		enter()
	}
	if b.failSync {
		return errors.New("native failure")
	}
	return nil
}

func (b *boundaryTaskbar) clear() error {
	b.clears++
	if b.clearEnter != nil {
		enter := b.clearEnter
		b.clearEnter = nil
		enter()
	}
	return nil
}
func (b *boundaryTaskbar) close() error { b.closes++; return nil }
func TestTaskbarShutdownFenceReentrantBeginDuringClear(t *testing.T) {
	backend := &boundaryTaskbar{}
	var c taskbarController
	c.backend, c.handle, c.state = backend, 1, TaskbarState{Epoch: 1, Seq: 1, Enabled: true}
	backend.clearEnter = func() { _, _ = c.begin(1) }
	if err := c.shutdown(); !errors.Is(err, errTaskbarSuperseded) {
		t.Fatalf("shutdown error = %v", err)
	}
	if c.backend != backend || c.handle != 1 || c.state.Epoch == 0 || backend.closes != 0 {
		t.Fatalf("old shutdown took new owner: backend=%p handle=%d state=%+v closes=%d", c.backend, c.handle, c.state, backend.closes)
	}
}

func TestTaskbarRebuildFenceReentrantBeginOnError(t *testing.T) {
	backend := &boundaryTaskbar{}
	var rebuild func()
	var c taskbarController
	c.open = func(_ uintptr, _ func(TaskbarAction), r func()) (taskbarBackend, error) {
		rebuild = r
		return backend, nil
	}
	epoch, err := c.begin(1)
	if err != nil {
		t.Fatal(err)
	}
	state := taskbarFixture()
	state.Epoch = epoch
	if err := c.sync(state); err != nil {
		t.Fatal(err)
	}
	backend.failSync = true
	backend.syncEnter = func() { _, _ = c.begin(1) }
	rebuild()
	if c.state.Epoch == 0 || c.backend != backend || backend.closes != 0 {
		t.Fatalf("rebuild error revoked new owner: state=%+v backend=%p closes=%d", c.state, c.backend, backend.closes)
	}
}
