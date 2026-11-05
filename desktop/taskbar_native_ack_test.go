package main

import (
	"errors"
	"testing"
)

func TestTaskbarControllerSameOwnerSupersededAcceptance(t *testing.T) {
	for _, lateFailure := range []bool{false, true} {
		e := nativeTaskbarFixture()
		c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
		reports := 0
		c.failure = func(TaskbarFailure) { reports++ }
		first := taskbarFixture()
		first.Epoch = 1
		next := first
		next.Seq = 2
		once := false
		e.invoke = func(method int, s TaskbarState, hide bool) error {
			if !hide && !once {
				once = true
				if c.sync(next) != errTaskbarQueued {
					t.Fatal("latest not accepted")
				}
				if lateFailure {
					return errors.New("obsolete HRESULT failure")
				}
			}
			return nil
		}
		err := c.sync(first)
		if err != errTaskbarQueued || taskbarAcceptance(err) != nil || c.state.Seq != 2 || !e.active || reports != 0 {
			t.Fatalf("same-owner replacement rejected: lateFailure=%v err=%v state=%+v reports=%d", lateFailure, err, c.state, reports)
		}
	}
}

func TestTaskbarControllerClearCannotBecomeSyncAcceptance(t *testing.T) {
	e := nativeTaskbarFixture()
	c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
	first := taskbarFixture()
	first.Epoch = 1
	once := false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && !once {
			once = true
			off := first
			off.Seq = 2
			off.Enabled = false
			_ = c.sync(off)
		}
		return nil
	}
	err := c.sync(first)
	if !errors.Is(err, errTaskbarSuperseded) || taskbarAcceptance(err) == nil || c.state.Seq != 2 || c.state.Enabled || e.active {
		t.Fatalf("clear incorrectly classified as sync acceptance: err=%v state=%+v", err, c.state)
	}
}

func TestTaskbarControllerCloseCannotBecomeSyncAcceptance(t *testing.T) {
	e := nativeTaskbarFixture()
	c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
	reports := 0
	c.failure = func(TaskbarFailure) { reports++ }
	first := taskbarFixture()
	first.Epoch = 1
	once := false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && !once {
			once = true
			next := first
			next.Seq = 2
			_ = c.sync(next)
			_ = e.close()
		}
		return nil
	}
	err := c.sync(first)
	if taskbarAcceptance(err) == nil || !e.closed || e.active || reports != 0 {
		t.Fatalf("close was accepted or reported as native failure: err=%v reports=%d", err, reports)
	}
}
