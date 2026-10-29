package main

import (
	"errors"
	"testing"
)

func TestTaskbarControllerAcceptedFailureAfterOwnerReplacement(t *testing.T) {
	old := nativeTaskbarFixture()
	next := nativeTaskbarFixture()
	c := taskbarController{backend: &old, handle: 1, counter: 1, state: TaskbarState{Epoch: 1}}
	reports := 0
	c.failure = func(TaskbarFailure) { reports++ }
	c.open = func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) { return &next, nil }
	next.invoke = func(int, TaskbarState, bool) error { return nil }
	first := taskbarFixture()
	first.Epoch = 1
	queued, replaced := false, false
	old.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && !queued {
			queued = true
			update := first
			update.Seq = 2
			if taskbarAcceptance(c.sync(update)) != nil {
				t.Fatal("queue acceptance failed")
			}
		} else if !hide && s.Seq == 2 && !replaced {
			replaced = true
			_ = c.shutdown()
			epoch, err := c.begin(2)
			if err != nil {
				t.Fatal(err)
			}
			update := first
			update.Epoch = epoch
			if err = c.sync(update); err != nil {
				t.Fatal(err)
			}
			return errors.New("accepted old-owner native failure")
		}
		return nil
	}
	_ = c.sync(first)
	if !replaced || reports != 0 || c.state.Epoch != 2 || !next.active || !old.closed {
		t.Fatalf("old accepted completion affected new owner: %+v reports=%d", c.state, reports)
	}
}

func TestTaskbarControllerNativePostedCompletionAndCommands(t *testing.T) {
	e := nativeTaskbarFixture()
	var click func(TaskbarAction)
	c := taskbarController{handle: 1, state: TaskbarState{Epoch: 1}}
	c.open = func(_ uintptr, command func(TaskbarAction), _ func()) (taskbarBackend, error) {
		click = command
		return &e, nil
	}
	commands, reports, posts := 0, 0, 0
	c.emit = func(command TaskbarCommand) {
		commands++
		if command.Seq != 100 {
			t.Errorf("command used stale ACK: %+v", command)
		}
	}
	c.failure = func(TaskbarFailure) { reports++ }
	e.post = func() error { posts++; return nil }
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		if !hide && (method == 15 || method == 16) {
			if e.active {
				click(TaskbarNext)
			}
			if s.Seq < 100 {
				update := s
				update.Seq++
				if taskbarAcceptance(c.sync(update)) != nil {
					t.Fatal("queued controller request rejected")
				}
			}
		}
		return nil
	}
	state := taskbarFixture()
	state.Epoch = 1
	_ = c.sync(state)
	if posts != 1 || e.pending == nil || c.state.Seq != 0 || commands != 0 || e.active {
		t.Fatal("posted work ACKed/applied before continuation")
	}
	for rounds := 0; e.pending != nil && rounds < 10; rounds++ {
		e.resume()
	}
	if !e.active || c.state.Seq != 100 || reports != 0 {
		t.Fatalf("posted latest completion lost: %+v", c.state)
	}
	if e.active {
		click(TaskbarNext)
	}
	if commands != 1 {
		t.Fatal("command gate did not open after completion")
	}
}

func TestTaskbarControllerExplorerReplayUsesLatestRequested(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		e := nativeTaskbarFixture()
		var rebuild func()
		c := taskbarController{handle: 1, state: TaskbarState{Epoch: 1}}
		c.open = func(_ uintptr, _ func(TaskbarAction), replay func()) (taskbarBackend, error) {
			rebuild = replay
			return &e, nil
		}
		state := taskbarFixture()
		state.Epoch = 1
		once := false
		e.invoke = func(method int, s TaskbarState, hide bool) error {
			if !hide && !once {
				once = true
				latest := state
				latest.Seq = 2
				latest.Enabled = enabled
				if c.sync(latest) != errTaskbarQueued {
					t.Fatal("latest not queued")
				}
				e.explorerCreated()
				rebuild()
			}
			return nil
		}
		_ = c.sync(state)
		if c.state.Seq != 2 || c.state.Enabled != enabled || e.active != enabled || e.pending != nil || e.deferredClear {
			t.Fatalf("Explorer restored obsolete state: %+v active=%v", c.state, e.active)
		}
	}
}

func TestTaskbarNativeClearCloseDuringCleanup(t *testing.T) {
	e := nativeTaskbarFixture()
	e.added = true
	e.active = true
	depth, releases := 0, 0
	e.release = func() error {
		if depth != 0 {
			t.Fatal("release within native invocation")
		}
		releases++
		return nil
	}
	once := false
	e.invoke = func(method int, s TaskbarState, hide bool) error {
		depth++
		defer func() { depth-- }()
		if hide && !once {
			once = true
			_ = e.close()
			if e.active {
				t.Fatal("close did not revoke gate")
			}
		}
		return nil
	}
	_ = e.clear()
	if releases != 1 || !e.closed || e.pending != nil || e.deferredClose || e.deferredClear {
		t.Fatal("cleanup close was stranded")
	}
}
