package main

import (
	"errors"
	"sync"
	"testing"
)

func TestUpdatesConcurrentCheckRevisions(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	h.driver.calls = make(chan updatesCheckCall, 64)
	epoch := h.begin(t, owner)
	var group sync.WaitGroup
	for revision := uint64(1); revision <= 32; revision++ {
		group.Add(1)
		go func() {
			defer group.Done()
			h.u.Check(owner, revision+100, epoch, revision)
		}()
	}
	group.Wait()
	accepted := 0
	for range 32 {
		h.run(t)
		if h.last(t).Code == "" {
			accepted++
		}
	}
	if h.u.session.state.OperationRevision != 32 {
		t.Fatal("concurrent arrival lowered the operation revision")
	}
	for range accepted {
		call := receiveUpdatesCheck(t, h.driver)
		call.reply <- updatesCheckReply{}
	}
	for range accepted {
		h.run(t)
	}
	if h.u.session.state.Phase != "no-update" || h.u.session.state.OperationRevision != 32 {
		t.Fatalf("late concurrent checks overwrote latest state: %+v", h.u.session.state)
	}
}

func TestUpdatesCancelledCheckCannotPublishCandidate(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	h.u.Check(owner, 2, epoch, 1)
	h.run(t)
	call := receiveUpdatesCheck(t, h.driver)
	// Exercise a worker context cancellation while the page owner remains live,
	// as with the check timeout, without waiting two minutes or using real I/O.
	h.u.session.stopWork()
	call.reply <- updatesCheckReply{candidate: &updatesFakeCandidate{}}
	h.run(t)
	if h.u.session.state.Phase != "error" || h.u.session.state.Code != "check-failed" || h.u.session.candidate != nil {
		t.Fatal("canceled worker result became an available candidate")
	}
}

func TestUpdatesBeginAndTeardownPreserveInstallFence(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	candidate := h.available(t, owner, epoch, 1)
	h.u.Install(owner, 3, epoch, 2)
	h.run(t)
	call := receiveUpdatesInstall(t, candidate)
	newEpoch := h.begin(t, owner)
	if newEpoch <= epoch || !h.u.session.installBusy || call.ctx.Err() == nil {
		t.Fatal("Begin cleared fence or failed to cancel old work")
	}
	h.u.Teardown(owner, 4, newEpoch)
	h.run(t)
	if !h.u.session.installBusy || h.u.session.owner != nil {
		t.Fatal("Teardown retained owner or cleared install fence")
	}
	count := len(h.events)
	call.reply <- errors.New("swap failed")
	h.run(t)
	if h.u.session.installBusy || h.u.session.state.Phase != "inactive" || len(h.events) != count {
		t.Fatal("SDK return revived torn-down session or retained fence")
	}
}
