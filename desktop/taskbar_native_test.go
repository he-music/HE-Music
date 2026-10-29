package main

import (
	"errors"
	"fmt"
	"testing"
)

func nativeTaskbarFixture() taskbarNativeExecutor {
	return taskbarNativeExecutor{taskbarNativeWindow: &taskbarNativeWindow{}}
}
func TestTaskbarNativeSyncClearDrains(t *testing.T) {
	e := nativeTaskbarFixture()
	hidden, none := false, false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if method == 10 && !hide {
			_ = e.clear()
			if e.active {
				t.Error("clear must close gate immediately")
			}
		}
		if method == 10 && hide {
			none = true
		}
		if method == 16 && hide {
			hidden = true
		}
		return nil
	}
	if err := e.sync(taskbarFixture()); !errors.Is(err, errTaskbarSuperseded) {
		t.Fatalf("obsolete sync ACK: %v", err)
	}
	if e.active || e.deferredClear || e.pending != nil || !hidden || !none {
		t.Fatalf("clear not drained: active=%v clear=%v hidden=%v none=%v", e.active, e.deferredClear, hidden, none)
	}
}
func TestTaskbarNativeClearSyncDoesNotDrift(t *testing.T) {
	e := nativeTaskbarFixture()
	e.added = true
	once := false
	latest := taskbarFixture()
	latest.Seq = 2
	applied := uint64(0)
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if method == 10 && hide && !once {
			once = true
			_ = e.sync(latest)
		}
		if method == 16 && !hide {
			applied = s.Seq
		}
		return nil
	}
	_ = e.clear()
	if e.pending != nil || applied != 2 || !e.active {
		t.Fatalf("clear left pending or lost sync: pending=%v applied=%v active=%v", e.pending, applied, e.active)
	}
	latest.Seq = 3
	if err := e.sync(latest); err != nil {
		t.Fatal(err)
	}
	if applied != 3 || e.pending != nil {
		t.Fatal("old pending drifted across unrelated operation")
	}
}
func TestTaskbarNativeCloseDefersRelease(t *testing.T) {
	for _, boundary := range []int{15, 10, 9} {
		t.Run(fmt.Sprint(boundary), func(t *testing.T) {
			e := nativeTaskbarFixture()
			inside, released := false, false
			e.release = func() error {
				if inside {
					t.Error("released during native call")
				}
				released = true
				return nil
			}
			e.invoke = func(method int, s TaskbarState, hide bool) error {
				inside = true
				defer func() { inside = false }()
				if method == boundary && !hide {
					_ = e.close()
					if e.active {
						t.Error("close gate remained active")
					}
					if e.sync(s) == nil {
						t.Error("close accepted new sync")
					}
				}
				return nil
			}
			_ = e.sync(taskbarFixture())
			if !released || !e.closed || e.active || e.deferredClose || e.deferredClear || e.pending != nil {
				t.Fatalf("close was not drained: released=%v closed=%v active=%v", released, e.closed, e.active)
			}
		})
	}
}
func TestTaskbarNativeSuccessfulAddSurvivesRevokeAndReopen(t *testing.T) {
	e := nativeTaskbarFixture()
	adds, updates, hides := 0, 0, 0
	invoke := func(method int, s TaskbarState, hide bool) error {
		if method == 15 {
			adds++
			_ = e.clear()
		}
		if method == 16 {
			updates++
			if hide {
				hides++
			}
		}
		return nil
	}
	e.invoke = invoke
	_ = e.sync(taskbarFixture())
	if !e.added || hides != 1 || e.active {
		t.Fatal("successful Add physical fact lost during revoke")
	}
	if err := e.sync(taskbarFixture()); err != nil {
		t.Fatal(err)
	}
	if adds != 1 || updates != 2 {
		t.Fatalf("repeated Add: adds=%d updates=%d", adds, updates)
	}
	_ = e.close()
	reopened := nativeTaskbarFixture()
	reopened.taskbarNativeWindow = e.taskbarNativeWindow
	reopened.invoke = invoke
	if err := reopened.sync(taskbarFixture()); err != nil {
		t.Fatal(err)
	}
	if adds != 1 {
		t.Fatal("live HWND reopen repeated Add")
	}
	reopened.explorerCreated()
	_ = reopened.sync(taskbarFixture())
	if adds != 2 {
		t.Fatal("Explorer recreation did not reset physical Add fact")
	}
}
func TestTaskbarNativeLatestCoalescingAndBoundedDrain(t *testing.T) {
	e := nativeTaskbarFixture()
	calls, depth, maxDepth, posts := 0, 0, 0, 0
	latest := uint64(0)
	const last = 500
	e.post = func() error { posts++; return nil }
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		depth++
		defer func() { depth-- }()
		if depth > maxDepth {
			maxDepth = depth
		}
		calls++
		if (method == 15 || method == 16) && !hide {
			latest = s.Seq
			if s.Seq < last {
				next := s
				next.Seq++
				if err := e.sync(next); err != errTaskbarQueued {
					t.Errorf("nested sync ACK: %v", err)
				}
				next.Seq++
				_ = e.sync(next)
			}
		}
		return nil
	}
	_ = e.sync(taskbarFixture())
	if calls > taskbarDrainBudget || posts != 1 || maxDepth != 1 || e.pending == nil {
		t.Fatalf("unbounded first drain: calls=%d posts=%d depth=%d", calls, posts, maxDepth)
	}
	for rounds := 0; e.pending != nil && rounds < last; rounds++ {
		e.resume()
	}
	if latest != 501 || e.pending != nil || !e.active || maxDepth != 1 {
		t.Fatalf("lost latest state: latest=%d pending=%v active=%v depth=%d", latest, e.pending, e.active, maxDepth)
	}
}
func TestTaskbarNativeClearClosePriority(t *testing.T) {
	e := nativeTaskbarFixture()
	sequence := []int{}
	e.release = func() error { sequence = append(sequence, 2); return nil }
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		sequence = append(sequence, method)
		if method == 15 {
			_ = e.clear()
			_ = e.sync(s)
			_ = e.close()
		}
		if hide && e.sync(s) == nil {
			t.Error("closing cleanup accepted sync")
		}
		return nil
	}
	_ = e.sync(taskbarFixture())
	want := []int{15, 10, 16, 2}
	if len(sequence) != len(want) {
		t.Fatal(sequence)
	}
	for i := range want {
		if sequence[i] != want[i] {
			t.Fatal(sequence)
		}
	}
}
func TestTaskbarNativeFailuresAreNotACKs(t *testing.T) {
	failure := errors.New("injected HRESULT failure")
	for _, boundary := range []int{15, 16, 10, 9} {
		e := nativeTaskbarFixture()
		e.added = boundary == 16
		e.invoke = func(method int, s TaskbarState, hide bool) error {
			if method == boundary {
				return failure
			}
			return nil
		}
		if err := e.sync(taskbarFixture()); !errors.Is(err, failure) || e.active {
			t.Fatalf("method %d failure ACK: %v active=%v", boundary, err, e.active)
		}
	}
	e := nativeTaskbarFixture()
	e.added = true
	e.invoke = func(method int, s TaskbarState, hide bool) error { return failure }
	if err := e.clear(); !errors.Is(err, failure) {
		t.Fatal("clear failure ACK")
	}
}
func TestTaskbarNativePostFailureRetires(t *testing.T) {
	e := nativeTaskbarFixture()
	failure := errors.New("post failed")
	released := false
	e.release = func() error { released = true; return nil }
	e.post = func() error { return failure }
	var final error
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide {
			next := s
			next.Seq++
			_ = e.submit(&next, func(err error) {
				if errors.Is(err, failure) {
					final = err
				}
			})
		}
		return nil
	}
	_ = e.sync(taskbarFixture())
	if !e.closed || !released || !errors.Is(final, failure) || e.pending != nil || e.active {
		t.Fatal("scheduler failure silently dropped native work")
	}
}
func TestTaskbarControllerNativeQueuedCommit(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			e := nativeTaskbarFixture()
			c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
			first := taskbarFixture()
			first.Epoch = 1
			next := first
			next.Seq = 2
			once := false
			failures := []TaskbarFailure{}
			c.failure = func(f TaskbarFailure) { failures = append(failures, f) }
			e.invoke = func(method int, s TaskbarState, hide bool) error {
				if !hide && !once {
					once = true
					err := c.sync(next)
					if err != errTaskbarQueued || taskbarAcceptance(err) != nil || c.state.Seq != 0 || e.active {
						t.Errorf("queued operation committed or gate opened early: %v state=%+v", err, c.state)
					}
				}
				if fail && !hide && s.Seq == 2 {
					return errors.New("queued native failure")
				}
				return nil
			}
			if err := c.sync(first); (fail && !errors.Is(err, errTaskbarSuperseded)) || (!fail && err != errTaskbarQueued) {
				t.Fatalf("old operation acceptance: %v", err)
			}
			if fail {
				if c.state.Epoch != 0 || e.active || len(failures) != 1 || failures[0] != (TaskbarFailure{Epoch: 1, Seq: 2, Code: "native-failed"}) {
					t.Fatalf("queued failure not reported once/cleaned: state=%+v failures=%v", c.state, failures)
				}
			} else if c.state.Seq != 2 || !e.active || len(failures) != 0 {
				t.Fatalf("latest completion lost: %+v active=%v", c.state, e.active)
			}
		})
	}
}
func TestTaskbarControllerNativeClearSyncCommit(t *testing.T) {
	e := nativeTaskbarFixture()
	e.added = true
	c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1, Seq: 1, Enabled: true}}
	off := taskbarFixture()
	off.Epoch = 1
	off.Seq = 2
	off.Enabled = false
	next := off
	next.Seq = 3
	next.Enabled = true
	once := false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if hide && !once {
			once = true
			if err := c.sync(next); err != errTaskbarQueued {
				t.Error(err)
			}
		}
		return nil
	}
	if err := c.sync(off); !errors.Is(err, errTaskbarSuperseded) {
		t.Fatal(err)
	}
	if c.state.Seq != 3 || !c.state.Enabled || !e.active || e.pending != nil {
		t.Fatalf("controller ACK drifted: %+v", c.state)
	}
}
func TestTaskbarControllerNativeOldFailureCannotRevokeNewOwner(t *testing.T) {
	old := nativeTaskbarFixture()
	next := nativeTaskbarFixture()
	c := taskbarController{backend: &old, handle: 1, counter: 1, state: TaskbarState{Epoch: 1}}
	failures := 0
	c.failure = func(TaskbarFailure) { failures++ }
	c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return &next, nil }
	next.invoke = func(int, TaskbarState, bool) error { return nil }
	first := taskbarFixture()
	first.Epoch = 1
	once := false
	old.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && !once {
			once = true
			_ = c.shutdown()
			epoch, err := c.begin(2)
			if err != nil {
				t.Fatal(err)
			}
			state := first
			state.Epoch = epoch
			if err = c.sync(state); err != nil {
				t.Fatal(err)
			}
			return errors.New("old owner HRESULT failure")
		}
		return nil
	}
	if err := c.sync(first); !errors.Is(err, errTaskbarSuperseded) || taskbarAcceptance(err) == nil {
		t.Fatalf("cross-owner replacement accepted: %v", err)
	}
	if c.state.Epoch != 2 || c.state.Seq != 1 || !next.active || failures != 0 || !old.closed {
		t.Fatalf("old owner revoked new owner: %+v failures=%d", c.state, failures)
	}
}
func TestTaskbarControllerNativeQueuedSequenceMonotonic(t *testing.T) {
	e := nativeTaskbarFixture()
	c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
	first := taskbarFixture()
	first.Epoch = 1
	once := false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && !once {
			once = true
			latest := first
			latest.Seq = 3
			if c.sync(latest) != errTaskbarQueued {
				t.Fatal("not queued")
			}
			stale := first
			stale.Seq = 2
			if c.sync(stale) == nil {
				t.Fatal("accepted sequence older than queued request")
			}
		}
		return nil
	}
	_ = c.sync(first)
	if c.state.Seq != 3 || !e.active {
		t.Fatal(c.state)
	}
}
func TestTaskbarAcceptanceDoesNotHideFailures(t *testing.T) {
	failure := errors.New("native failed")
	if taskbarAcceptance(nil) != nil || taskbarAcceptance(errTaskbarQueued) != nil {
		t.Fatal("acceptance rejected")
	}
	if !errors.Is(taskbarAcceptance(errors.Join(failure, errTaskbarQueued)), failure) {
		t.Fatal("joined native failure hidden")
	}
	e := nativeTaskbarFixture()
	c := taskbarController{backend: &e, handle: 1, state: TaskbarState{Epoch: 1}}
	reports := 0
	c.failure = func(TaskbarFailure) { reports++ }
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide {
			return failure
		}
		return nil
	}
	state := taskbarFixture()
	state.Epoch = 1
	if !errors.Is(c.sync(state), failure) || reports != 0 {
		t.Fatal("synchronous failure emitted duplicate async event")
	}
}
