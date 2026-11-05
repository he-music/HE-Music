package main

import (
	"errors"
	"testing"
)

type fakeTaskbarHook struct {
	installed      bool
	failure        error
	calls          int
	destroyedCalls int
	onRemove       func()
}

func (f *fakeTaskbarHook) removeHook() error {
	f.calls++
	if f.onRemove != nil {
		f.onRemove()
	}
	if f.failure != nil {
		return f.failure
	}
	f.installed = false
	return nil
}
func (f *fakeTaskbarHook) hookDestroyed() { f.installed = false; f.destroyedCalls++ }

func TestTaskbarHookRetryKeepsWindowObserverThroughConstructorFailure(t *testing.T) {
	failure := errors.New("remove failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	var h taskbarHookHandoff
	_ = h.replace(previous, next)
	previous.failure, next.failure = nil, nil
	if err := h.retryKeeping(previous); err != nil {
		t.Fatal(err)
	}
	// The next constructor can pump Explorer recreation or fail before it installs
	// its replacement. The record's previous observer must cover that whole gap.
	if !previous.installed || next.installed {
		t.Fatal("cleanup removed the window observer before a replacement existed")
	}
	if h.retained[0] != nil || h.retained[1] != nil {
		t.Fatal("the record observer must resume ownership outside quarantine")
	}
	replacement := &fakeTaskbarHook{installed: true}
	if err := h.replace(previous, replacement); err != nil || previous.installed || !replacement.installed {
		t.Fatal("observer was not transferred after the new hook was installed", err)
	}
}

func TestTaskbarHookRetryKeepingObserverRejectsFailureAndDestroyReentry(t *testing.T) {
	failure := errors.New("remove failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	var h taskbarHookHandoff
	_ = h.replace(previous, next)
	next.onRemove = func() {
		if h.retryKeeping(previous) == nil {
			t.Fatal("reentrant cleanup admitted an installation")
		}
	}
	for range 100 {
		if h.retryKeeping(previous) == nil {
			t.Fatal("failed replacement cleanup admitted an installation")
		}
	}
	if previous.calls != 1 || next.calls != 101 || !previous.installed || !next.installed || h.retained[0] != previous || h.retained[1] != next {
		t.Fatal("cleanup removed the observer or lost a bounded retained hook")
	}
	next.failure = nil
	next.onRemove = h.destroyed
	if h.retryKeeping(previous) == nil || !h.dead || previous.installed || next.installed || previous.destroyedCalls != 1 || next.destroyedCalls != 1 || h.retained[0] != nil || h.retained[1] != nil {
		t.Fatal("destroy during cleanup retained a hook or admitted a new installation")
	}
}

func TestTaskbarHookHandoffDoubleRemoveFailureBounded(t *testing.T) {
	failure := errors.New("RemoveWindowSubclass failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	var h taskbarHookHandoff
	if err := h.replace(previous, next); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if previous.calls != 1 || next.calls != 1 || !previous.installed || !next.installed {
		t.Fatal("did not independently attempt both removals")
	}
	for range 100 {
		if h.retry() == nil {
			t.Fatal("failed native removals permit another subclass installation")
		}
	}
	if h.retained[0] != previous || h.retained[1] != next {
		t.Fatal("failed hooks lost from bounded record")
	}
	previous.failure = nil
	if h.retry() == nil || previous.installed || !next.installed {
		t.Fatal("partial cleanup admitted another open")
	}
	next.failure = nil
	if err := h.retry(); err != nil {
		t.Fatal(err)
	}
	if previous.installed || next.installed || h.retained[0] != nil || h.retained[1] != nil {
		t.Fatal("retry did not clear quarantine")
	}
}

func TestTaskbarHookHandoffDestroyedRetiresBoth(t *testing.T) {
	failure := errors.New("RemoveWindowSubclass failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	var h taskbarHookHandoff
	_ = h.replace(previous, next)
	h.destroyed()
	h.destroyed()
	if previous.installed || next.installed || previous.destroyedCalls != 1 || next.destroyedCalls != 1 || h.retained[0] != nil || h.retained[1] != nil || h.retry() == nil {
		t.Fatal("HWND destruction did not retire every tracked hook exactly once")
	}
}

func TestTaskbarHookHandoffRollbackSuccessStillTracksPrevious(t *testing.T) {
	failure := errors.New("old subclass remove failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true}
	var h taskbarHookHandoff
	if h.replace(previous, next) == nil || next.installed {
		t.Fatal("rollback did not remove new hook")
	}
	if h.retry() == nil || h.retained[0] != previous || h.retained[1] != nil {
		t.Fatal("failed previous removal was forgotten")
	}
	h.destroyed()
	if previous.installed || next.destroyedCalls != 0 {
		t.Fatal("destroyed an already removed native hook")
	}
}

func TestTaskbarHookHandoffRetryReentryIsBounded(t *testing.T) {
	failure := errors.New("remove failed")
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	var h taskbarHookHandoff
	_ = h.replace(previous, next)
	nested := 0
	previous.onRemove = func() {
		nested++
		if h.retry() == nil {
			t.Fatal("reentrant cleanup admitted another open")
		}
	}
	_ = h.retry()
	if nested != 1 || previous.calls != 2 || next.calls != 2 {
		t.Fatal("cleanup recursed or skipped independent removal")
	}
}

func TestTaskbarHookDestroyDoesNotDeleteReusedHWNDRecord(t *testing.T) {
	type record struct {
		cookie uintptr
		hooks  taskbarHookHandoff
	}
	failure := errors.New("remove failed")
	old := &record{cookie: 1}
	previous := &fakeTaskbarHook{installed: true, failure: failure}
	next := &fakeTaskbarHook{installed: true, failure: failure}
	_ = old.hooks.replace(previous, next)
	records := map[uintptr]*record{10: old}
	taskbarDestroyHookRecord(&old.hooks, records, 10, old)
	if len(records) != 0 || previous.installed || next.installed {
		t.Fatal("destroy retained HWND or hook roots")
	}
	fresh := &record{cookie: 2}
	records[10] = fresh
	taskbarDestroyHookRecord(&old.hooks, records, 10, old)
	if records[10] != fresh || records[10].cookie != 2 || fresh.hooks.retry() != nil {
		t.Fatal("late old destroy affected new HWND cookie")
	}
	newer := &fakeTaskbarHook{installed: true}
	// Fresh HWND has no old quarantine and can perform its own hook handoff.
	replacement := &fakeTaskbarHook{installed: true}
	if fresh.hooks.replace(newer, replacement) != nil || !replacement.installed {
		t.Fatal("new HWND inherited old quarantine")
	}
}
