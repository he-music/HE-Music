package main

import (
	"errors"
	"fmt"
	"testing"
)

func TestTaskbarBeginInsideNativeDrain(t *testing.T) {
	for _, handle := range []uintptr{1, 2} {
		t.Run(map[uintptr]string{1: "same-HWND", 2: "other-HWND"}[handle], func(t *testing.T) {
			old := nativeTaskbarFixture()
			fresh := nativeTaskbarFixture()
			c := taskbarController{backend: &old, handle: 1, counter: 1, state: TaskbarState{Epoch: 1, Seq: 1, Enabled: true}}
			c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return &fresh, nil }
			fresh.invoke = func(int, TaskbarState, bool) error { return nil }
			first := taskbarFixture()
			first.Epoch = 1
			first.Seq = 2
			once := false
			nextEpoch := uint64(0)
			old.active = true
			old.invoke = func(method int, s TaskbarState, hidden bool) error {
				if hidden || once {
					return nil
				}
				once = true
				epoch, err := c.begin(handle)
				requireTestNoError(t, err)
				nextEpoch = epoch
				if epoch != 2 || c.state.Enabled || old.active {
					t.Fatalf("Begin opened gate or failed owner switch: %+v active=%v", c.state, old.active)
				}
				if c.sync(first) == nil {
					t.Fatal("old owner's state accepted")
				}
				next := first
				next.Epoch = epoch
				next.Seq = 1
				err = c.sync(next)
				if handle == 1 {
					requireTestEqual(t, err, errTaskbarQueued)
					requireTestEqual(t, c.state.Enabled, false)
					requireTestEqual(t, old.active, false)
				} else {
					requireTestNoError(t, err)
				}
				return nil
			}
			if err := c.sync(first); !errors.Is(err, errTaskbarSuperseded) {
				t.Fatalf("old operation was ACKed: %v", err)
			}
			current := &old
			if handle != 1 {
				current = &fresh
			}
			if nextEpoch != 2 || c.state.Epoch != 2 || c.state.Seq != 1 || !c.state.Enabled || !current.active {
				t.Fatalf("new owner did not complete: %+v active=%v", c.state, current.active)
			}
			if handle != 1 && (!old.closed || old.active) {
				t.Fatal("old HWND did not retire")
			}
		})
	}
}

func TestTaskbarBeginPreservesCleanupErrors(t *testing.T) {
	failure := errors.New("real native clear failure")
	e := nativeTaskbarFixture()
	e.invoke = func(int, TaskbarState, bool) error { return failure }
	c := taskbarController{backend: &e, handle: 1, counter: 1, state: TaskbarState{Epoch: 1, Enabled: true}}
	if epoch, err := c.begin(1); epoch != 0 || !errors.Is(err, failure) || c.counter != 1 {
		t.Fatalf("real cleanup error accepted: epoch=%d err=%v", epoch, err)
	}
	e.deferredClose = true
	if epoch, err := c.begin(1); epoch != 0 || err == nil {
		t.Fatalf("closing backend accepted Begin: %d %v", epoch, err)
	}
}

func TestTaskbarQueuedCleanupChecksEveryLeaf(t *testing.T) {
	failure := errors.New("real native cleanup failure")
	cases := []struct {
		err      error
		accepted bool
	}{
		{nil, false},
		{errTaskbarQueued, true},
		{errors.Join(errTaskbarQueued, errTaskbarQueued), true},
		{fmt.Errorf("cleanup: %w", errors.Join(errTaskbarQueued, errTaskbarQueued)), true},
		{errors.Join(errTaskbarQueued, failure), false},
		{errors.Join(failure, errTaskbarQueued), false},
		{errors.Join(errTaskbarQueued, errors.Join(errTaskbarQueued, failure)), false},
		{errTaskbarSuperseded, false},
	}
	for _, test := range cases {
		if got := taskbarQueuedCleanup(test.err); got != test.accepted {
			t.Fatalf("cleanup %v acceptance=%v want=%v", test.err, got, test.accepted)
		}
	}
}

type taskbarBeginCleanupFault struct {
	taskbarNativeExecutor
	clearFault, closeFault error
}

func (b *taskbarBeginCleanupFault) clear() error {
	return errors.Join(b.taskbarNativeExecutor.clear(), b.clearFault)
}

func (b *taskbarBeginCleanupFault) close() error {
	return errors.Join(b.taskbarNativeExecutor.close(), b.closeFault)
}

func TestTaskbarBeginRejectsJoinedRealCleanupFailure(t *testing.T) {
	for _, closeFailure := range []bool{false, true} {
		failure := errors.New("real cleanup failure")
		backend := &taskbarBeginCleanupFault{taskbarNativeExecutor: nativeTaskbarFixture()}
		backend.invoke = func(int, TaskbarState, bool) error { return nil }
		c := taskbarController{backend: backend, handle: 1, counter: 1, state: TaskbarState{Epoch: 1}}
		target := uintptr(1)
		if closeFailure {
			backend.closeFault = errors.Join(errTaskbarQueued, failure)
			target = 2
		} else {
			backend.clearFault = errors.Join(errTaskbarQueued, failure)
		}
		if epoch, err := c.begin(target); epoch != 0 || !errors.Is(err, failure) || c.counter != 1 {
			t.Fatalf("joined real failure ACKed: epoch=%d err=%v", epoch, err)
		}
	}
}

func TestTaskbarBeginCannotOverwriteReentrantNewOwner(t *testing.T) {
	e := nativeTaskbarFixture()
	c := taskbarController{backend: &e, handle: 1, counter: 1, state: TaskbarState{Epoch: 1}}
	once := false
	e.invoke = func(method int, s TaskbarState, hidden bool) error {
		if hidden && !once {
			once = true
			epoch, err := c.begin(1)
			if err != nil || epoch != 2 {
				t.Fatalf("nested Begin: epoch=%d err=%v", epoch, err)
			}
			next := taskbarFixture()
			next.Epoch = epoch
			if c.sync(next) != errTaskbarQueued {
				t.Fatal("new owner sync was not queued")
			}
		}
		return nil
	}
	if epoch, err := c.begin(1); epoch != 0 || !errors.Is(err, errTaskbarSuperseded) {
		t.Fatalf("old Begin overwrote new owner: %d %v", epoch, err)
	}
	if c.state.Epoch != 2 || c.state.Seq != 1 || !e.active || c.counter != 2 {
		t.Fatalf("new owner lost: %+v", c.state)
	}
}
