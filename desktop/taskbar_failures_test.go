package main

import (
	"errors"
	"testing"
)

type taskbarClearFailure struct{ closes int }

func (*taskbarClearFailure) sync(TaskbarState) error { return nil }
func (*taskbarClearFailure) clear() error            { return errors.New("native clear failed") }
func (b *taskbarClearFailure) close() error          { b.closes++; return nil }
func TestTaskbarClearFailureRetiresCommandsAndStillReleases(t *testing.T) {
	b := &taskbarClearFailure{}
	c := taskbarController{backend: b, handle: 12, state: TaskbarState{Epoch: 1, Seq: 1, Enabled: true}}
	next := taskbarFixture()
	next.Epoch = 1
	next.Seq = 2
	next.Enabled = false
	if c.sync(next) == nil || c.state.Enabled {
		t.Fatal("native clear failure reported success or retained command gate")
	}
	if c.revoke() == nil || c.state.Epoch != 0 {
		t.Fatal("revoke failure reported success or retained owner")
	}
	if c.shutdown() == nil || b.closes != 1 || c.backend != nil {
		t.Fatal("cleanup failure prevented final release")
	}
	if c.shutdown() != nil || b.closes != 1 {
		t.Fatal("final release not idempotent")
	}
}
