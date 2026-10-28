package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type updatesCheckReply struct {
	candidate updatesCandidate
	err       error
}

type updatesCheckCall struct {
	ctx   context.Context
	reply chan updatesCheckReply
}

type updatesFakeDriver struct{ calls chan updatesCheckCall }

func (d *updatesFakeDriver) check(ctx context.Context) (updatesCandidate, error) {
	call := updatesCheckCall{ctx: ctx, reply: make(chan updatesCheckReply, 1)}
	d.calls <- call
	r := <-call.reply // Deliberately ignores cancellation to exercise late results.
	return r.candidate, r.err
}

type updatesInstallCall struct {
	ctx   context.Context
	reply chan error
}

type updatesFakeCandidate struct{ calls chan updatesInstallCall }

func (c *updatesFakeCandidate) metadata() (string, string, string) {
	return "2.0.0", "release notes", "2026-10-01T00:00:00Z"
}

func (c *updatesFakeCandidate) install(ctx context.Context) error {
	call := updatesInstallCall{ctx: ctx, reply: make(chan error, 1)}
	c.calls <- call
	return <-call.reply // SDK swap is not guaranteed to respect cancellation.
}

type updatesHarness struct {
	u      *Updates
	driver *updatesFakeDriver
	queue  chan func()
	events []UpdatesEvent
}

func newUpdatesHarness(t *testing.T) (*updatesHarness, context.Context) {
	t.Helper()
	owner, cancel := context.WithCancel(context.Background())
	h := &updatesHarness{
		driver: &updatesFakeDriver{calls: make(chan updatesCheckCall, 8)},
		queue:  make(chan func(), 128),
	}
	h.u = newUpdates(h.driver, func(fn func()) { h.queue <- fn }, func(context.Context) bool { return true }, func(_ context.Context, e UpdatesEvent) error {
		h.events = append(h.events, e)
		return nil
	})
	t.Cleanup(func() { h.u.revoke(); cancel() })
	return h, owner
}

func (h *updatesHarness) run(t *testing.T) {
	t.Helper()
	select {
	case fn := <-h.queue:
		fn()
	case <-time.After(2 * time.Second):
		t.Fatal("dispatcher did not receive work")
	}
}

func (h *updatesHarness) last(t *testing.T) UpdatesEvent {
	t.Helper()
	if len(h.events) == 0 {
		t.Fatal("missing event")
	}
	return h.events[len(h.events)-1]
}

func (h *updatesHarness) begin(t *testing.T, owner context.Context) uint64 {
	t.Helper()
	h.u.Begin(owner, 1)
	h.run(t)
	return h.last(t).State.Epoch
}

func receiveUpdatesCheck(t *testing.T, d *updatesFakeDriver) updatesCheckCall {
	t.Helper()
	select {
	case call := <-d.calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("check worker did not start")
		return updatesCheckCall{}
	}
}

func receiveUpdatesInstall(t *testing.T, c *updatesFakeCandidate) updatesInstallCall {
	t.Helper()
	select {
	case call := <-c.calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("install worker did not start")
		return updatesInstallCall{}
	}
}

func (h *updatesHarness) available(t *testing.T, owner context.Context, epoch, revision uint64) *updatesFakeCandidate {
	t.Helper()
	h.u.Check(owner, 2, epoch, revision)
	h.run(t)
	call := receiveUpdatesCheck(t, h.driver)
	candidate := &updatesFakeCandidate{calls: make(chan updatesInstallCall, 8)}
	call.reply <- updatesCheckReply{candidate: candidate}
	h.run(t)
	if h.last(t).State.Phase != "available" {
		t.Fatalf("not available: %+v", h.last(t))
	}
	return candidate
}

func TestUpdatesOwnerEpochAndAsyncAuthorization(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	h.u.Begin(owner, 10)
	if h.u.session.owner != nil || len(h.events) != 0 {
		t.Fatal("binding ran before dispatcher")
	}
	h.run(t)
	epoch := h.last(t).State.Epoch
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.u.Check(foreign, 11, epoch, 1)
	h.run(t)
	if h.last(t).Code != "session-unavailable" {
		t.Fatal("foreign owner accepted")
	}
	newEpoch := h.begin(t, owner)
	if newEpoch <= epoch {
		t.Fatal("epoch did not advance")
	}
	h.u.Install(owner, 12, epoch, 1)
	h.run(t)
	if h.last(t).Code != "session-unavailable" {
		t.Fatal("stale epoch accepted")
	}
	h.u.valid = func(context.Context) bool { return false }
	count := len(h.events)
	h.u.Begin(foreign, 13)
	h.run(t)
	if len(h.events) != count || h.u.session.state.Epoch != newEpoch {
		t.Fatal("unauthorized main-page caller changed state or received an event")
	}
}

func TestUpdatesCheckReplacementCancelsAndIgnoresLateResult(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	h.u.Check(owner, 2, epoch, 1)
	h.run(t)
	old := receiveUpdatesCheck(t, h.driver)
	h.u.Check(owner, 3, epoch, 2)
	h.run(t)
	current := receiveUpdatesCheck(t, h.driver)
	if old.ctx.Err() == nil {
		t.Fatal("replacement did not cancel old check")
	}
	current.reply <- updatesCheckReply{}
	h.run(t)
	before := h.u.session.snapshot()
	count := len(h.events)
	old.reply <- updatesCheckReply{candidate: &updatesFakeCandidate{}}
	h.run(t)
	if h.u.session.snapshot() != before || len(h.events) != count || before.Phase != "no-update" {
		t.Fatal("late check resurrected a candidate")
	}
	h.u.Check(owner, 4, epoch, 2)
	h.run(t)
	if h.last(t).Code != "stale-operation" {
		t.Fatal("duplicate revision accepted")
	}
}

func TestUpdatesTeardownAndOwnerCancellation(t *testing.T) {
	for _, mode := range []string{"teardown", "revoke", "navigation"} {
		t.Run(mode, func(t *testing.T) {
			h, _ := newUpdatesHarness(t)
			owner, cancel := context.WithCancel(context.Background())
			defer cancel()
			epoch := h.begin(t, owner)
			h.u.Check(owner, 2, epoch, 1)
			h.run(t)
			call := receiveUpdatesCheck(t, h.driver)
			switch mode {
			case "teardown":
				h.u.Teardown(owner, 3, epoch)
				h.run(t)
			case "revoke":
				h.u.revoke()
			case "navigation":
				cancel()
				h.run(t)
			}
			if call.ctx.Err() == nil || h.u.session.owner != nil {
				t.Fatal("work/owner survived teardown")
			}
			call.reply <- updatesCheckReply{candidate: &updatesFakeCandidate{}}
			h.run(t)
			if h.u.session.state.Phase != "inactive" || h.u.session.candidate != nil {
				t.Fatal("late result revived torn-down session")
			}
		})
	}
}

func TestUpdatesUnavailableErrorsAndNoUpdateAreDistinct(t *testing.T) {
	for _, tc := range []struct {
		name, phase, code string
		err               error
	}{
		{"unconfigured", "unavailable", "unavailable", errUpdatesUnavailable},
		{"offline", "error", "check-failed", errors.New("secret /private/install/path")},
		{"up-to-date", "no-update", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, owner := newUpdatesHarness(t)
			epoch := h.begin(t, owner)
			h.u.Check(owner, 2, epoch, 1)
			h.run(t)
			call := receiveUpdatesCheck(t, h.driver)
			call.reply <- updatesCheckReply{err: tc.err}
			h.run(t)
			state := h.last(t).State
			if state.Phase != tc.phase || state.Code != tc.code || strings.Contains(state.Code, "private") {
				t.Fatalf("wrong state or leaked error: %+v", state)
			}
		})
	}
}

func TestUpdatesDownloadHasNoInstallationSideEffects(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	epoch := h.begin(t, owner)
	candidate := h.available(t, owner, epoch, 1)
	before := h.u.session.snapshot()
	h.u.Download(owner, 3, epoch, 2)
	h.run(t)
	if h.last(t).Code != "unsupported" || h.u.session.snapshot() != before || len(candidate.calls) != 0 || len(h.driver.calls) != 0 {
		t.Fatal("Download started work or claimed completion")
	}
}

func TestUpdatesInstallStateAndCandidateConditions(t *testing.T) {
	for _, installErr := range []error{nil, errors.New("invalid signature: /secret/path")} {
		t.Run(map[bool]string{true: "success", false: "failure"}[installErr == nil], func(t *testing.T) {
			h, owner := newUpdatesHarness(t)
			epoch := h.begin(t, owner)
			h.u.Install(owner, 2, epoch, 1)
			h.run(t)
			if h.last(t).Code != "candidate-unavailable" {
				t.Fatal("installed without candidate")
			}
			candidate := h.available(t, owner, epoch, 1)
			h.u.Install(owner, 3, epoch, 2)
			h.run(t)
			call := receiveUpdatesInstall(t, candidate)
			if h.last(t).State.Phase != "installing" || !h.last(t).State.InstallBusy {
				t.Fatal("installation prematurely claimed complete")
			}
			h.u.Install(owner, 4, epoch, 3)
			h.run(t)
			if h.last(t).Code != "install-busy" {
				t.Fatal("concurrent installation accepted")
			}
			call.reply <- installErr
			h.run(t)
			state := h.last(t).State
			if state.InstallBusy || h.u.session.candidate != nil {
				t.Fatal("fence or consumed candidate retained")
			}
			if installErr == nil && (state.Phase != "installed" || state.Code != "restart-required") {
				t.Fatalf("successful SDK return not mapped correctly: %+v", state)
			}
			if installErr != nil && (state.Phase != "error" || state.Code != "install-failed") {
				t.Fatalf("SDK error not mapped correctly: %+v", state)
			}
		})
	}
}

func TestUpdatesInstallFenceSurvivesEpochRevokeAndLateReturn(t *testing.T) {
	for _, installErr := range []error{nil, errors.New("SDK failure")} {
		t.Run(map[bool]string{true: "success", false: "failure"}[installErr == nil], func(t *testing.T) {
			h, owner := newUpdatesHarness(t)
			epoch := h.begin(t, owner)
			candidate := h.available(t, owner, epoch, 1)
			h.u.Install(owner, 3, epoch, 2)
			h.run(t)
			oldInstall := receiveUpdatesInstall(t, candidate)
			h.u.revoke()
			newOwner, cancel := context.WithCancel(context.Background())
			defer cancel()
			newEpoch := h.begin(t, newOwner)
			if newEpoch <= epoch || !h.u.session.snapshot().InstallBusy || oldInstall.ctx.Err() == nil {
				t.Fatal("revoke cleared fence or failed to cancel context")
			}
			h.u.Check(newOwner, 4, newEpoch, 1)
			h.run(t)
			if h.last(t).Code != "install-busy" {
				t.Fatal("new check bypassed old install fence")
			}
			h.u.Install(newOwner, 5, newEpoch, 2)
			h.run(t)
			if h.last(t).Code != "install-busy" || len(candidate.calls) != 0 {
				t.Fatal("new epoch installation bypassed old fence")
			}
			oldInstall.reply <- installErr
			h.run(t)
			state := h.u.session.snapshot()
			if state.InstallBusy || state.Epoch != newEpoch || state.Phase != "idle" || state.Version != "" {
				t.Fatalf("old return polluted new session or retained fence: %+v", state)
			}
			if h.last(t).RequestID != 0 {
				t.Fatal("old request acknowledgment delivered to new owner")
			}
			newCandidate := h.available(t, newOwner, newEpoch, 1)
			h.u.Install(newOwner, 6, newEpoch, 2)
			h.run(t)
			newInstall := receiveUpdatesInstall(t, newCandidate)
			newInstall.reply <- nil
			h.run(t)
			if h.u.session.state.Phase != "installed" {
				t.Fatal("fence was not reusable after actual SDK return")
			}
		})
	}
}

func TestUpdatesEventFailureRevokesSession(t *testing.T) {
	h, owner := newUpdatesHarness(t)
	h.u.emit = func(context.Context, UpdatesEvent) error { return errors.New("page gone") }
	h.u.Begin(owner, 1)
	h.run(t)
	if h.u.session.owner != nil || h.u.session.state.Phase != "inactive" {
		t.Fatal("event failure retained authority")
	}
}
