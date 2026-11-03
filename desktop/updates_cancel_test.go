package main

import (
	"context"
	"errors"
	"testing"
)

func TestUpdatesCancelWaitsForActualInstallResult(t *testing.T) {
	for _, test := range []struct {
		name  string
		err   error
		phase string
	}{
		{"cancelled", context.Canceled, "cancelled"},
		{"already-applied", nil, "installed"},
		{"failed", errors.New("installation failed"), "error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, owner := newUpdatesHarness(t)
			epoch := h.begin(t, owner)
			candidate := h.available(t, owner, epoch, 1)
			h.u.Install(owner, 3, epoch, 2)
			h.run(t)
			call := receiveUpdatesInstall(t, candidate)
			call.progress(20, 100)
			h.run(t)
			h.u.Cancel(owner, 4, epoch, 2)
			h.run(t)
			if call.ctx.Err() == nil || !h.u.session.installBusy || h.last(t).State.Code != "cancel-requested" {
				t.Fatal("cancellation did not cancel the worker while retaining the fence")
			}
			h.u.Install(owner, 5, epoch, 3)
			h.run(t)
			if h.last(t).Code != "install-busy" {
				t.Fatal("cancellation released the fence before the SDK returned")
			}
			call.reply <- test.err
			h.run(t)
			if h.u.session.installBusy || h.last(t).State.Phase != test.phase || h.last(t).RequestID != 3 {
				t.Fatalf("incorrect actual result: %+v", h.last(t))
			}
		})
	}
}

func TestUpdatesCancelRejectsForeignStaleAndCompletedDownload(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	candidate := h.available(t, owner, epoch, 1)
	h.u.Install(owner, 3, epoch, 2)
	h.run(t)
	call := receiveUpdatesInstall(t, candidate)
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.u.Cancel(foreign, 4, epoch, 2)
	h.run(t)
	if h.last(t).Code != "session-unavailable" || call.ctx.Err() != nil {
		t.Fatal("foreign cancellation accepted")
	}
	h.u.Cancel(owner, 5, epoch, 1)
	h.run(t)
	if h.last(t).Code != "stale-operation" || call.ctx.Err() != nil {
		t.Fatal("stale cancellation accepted")
	}
	call.progress(100, 100)
	h.run(t)
	h.u.Cancel(owner, 6, epoch, 2)
	h.run(t)
	if h.last(t).Code != "cancel-unavailable" || call.ctx.Err() != nil {
		t.Fatal("cancellation accepted during verification or replacement")
	}
	call.reply <- nil
	h.run(t)
	if h.last(t).State.Phase != "installed" {
		t.Fatal("rejected cancellation changed installation result")
	}
}
