package main

import (
	"testing"
	"time"
)

func TestUpdatesProgressAndExplicitRestart(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	restarts := 0
	h.u.relaunch = func() { restarts++ }
	h.u.Restart(owner, 2, epoch, 1)
	h.run(t)
	if h.last(t).Code != "restart-unavailable" || restarts != 0 {
		t.Fatal("restart before install")
	}
	candidate := h.available(t, owner, epoch, 1)
	h.u.Install(owner, 3, epoch, 2)
	h.run(t)
	call := receiveUpdatesInstall(t, candidate)
	call.progress(50, 100)
	h.run(t)
	state := h.last(t).State
	if state.Phase != "installing" || state.Downloaded != 50 || state.Total != 100 {
		t.Fatal(state)
	}
	call.progress(100, 100)
	h.run(t)
	if h.last(t).State.Phase != "installing" || restarts != 0 {
		t.Fatal("download completion became install/restart")
	}
	call.reply <- nil
	h.run(t)
	if h.last(t).State.Phase != "installed" || restarts != 0 {
		t.Fatal("install auto restarted")
	}
	h.u.Restart(owner, 4, epoch, 3)
	h.run(t)
	if restarts != 0 || h.last(t).RequestID != 4 || h.last(t).Code != "" {
		t.Fatal("restart preceded acknowledgement")
	}
	h.run(t)
	if restarts != 1 {
		t.Fatal("explicit restart not dispatched")
	}
}

func TestUpdatesProgressCannotEscapeItsOwnerOrOperation(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	candidate := h.available(t, owner, epoch, 1)
	h.u.Install(owner, 3, epoch, 2)
	h.run(t)
	call := receiveUpdatesInstall(t, candidate)
	newOwner := t.Context()
	newEpoch := h.begin(t, newOwner)
	call.progress(99, 100)
	h.run(t)
	if h.u.session.state.Epoch != newEpoch || h.u.session.state.Downloaded != 0 {
		t.Fatal("late progress leaked")
	}
	call.reply <- nil
	h.run(t)
	if h.u.session.state.Phase != "idle" || h.u.session.snapshot().InstallBusy {
		t.Fatal("late install leaked")
	}
}

func TestUpdatesProgressReporterThrottlesAndFlushesLastSample(t *testing.T) {
	var samples [][2]int64
	reporter := newUpdatesProgressReporter(func(downloaded, total int64) { samples = append(samples, [2]int64{downloaded, total}) })
	clock := time.Unix(1, 0)
	reporter.now = func() time.Time { return clock }
	reporter.report(1, 100)
	reporter.report(50, 100)
	if len(samples) != 1 {
		t.Fatal("unthrottled progress")
	}
	reporter.finish()
	if len(samples) != 2 || samples[1] != [2]int64{50, 100} {
		t.Fatal(samples)
	}
	reporter.report(100, 100)
	if len(samples) != 3 {
		t.Fatal("final byte count was throttled")
	}
	reporter.finish()
	if len(samples) != 3 {
		t.Fatal("duplicated final progress")
	}
}
