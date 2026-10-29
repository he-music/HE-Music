package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/egoist/mygo"
)

func TestDownloadForgetUnknownBeforeFirstStart(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	id := downloadReq(t, token, "unknown.mp3").OperationID
	if ok, err := c.forget(a.state, ctx, epoch, id); ok || err != nil {
		t.Fatalf("current owner without a download must see unknown=false: ok=%v err=%v", ok, err)
	}
	c.mu.Lock()
	c.owner = context.Background()
	c.epoch = epoch + 1
	c.mu.Unlock()
	if ok, err := c.forget(a.state, ctx, epoch, id); ok || err != nil {
		t.Fatalf("old coordinator must not change current owner's unknown result: ok=%v err=%v", ok, err)
	}
	if ok, err := c.forget(a.state, context.Background(), epoch, id); ok || !errors.Is(err, errFilesOwner) {
		t.Fatalf("foreign file owner must still be rejected: ok=%v err=%v", ok, err)
	}
}

func TestDownloadForgetReclaimsCapacityAndRejectsReplay(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("fake network failure")
	})
	requests := make([]DownloadRequest, 0, downloadMaxJobs)
	for i := 0; i < downloadMaxJobs; i++ {
		req := downloadReq(t, token, fmt.Sprintf("song-%d.mp3", i))
		j := downloadStart(t, a, ctx, epoch, c, req)
		downloadWait(t, j)
		requests = append(requests, req)
	}
	if _, err := a.state.startDownload(ctx, epoch, downloadReq(t, token, "full.mp3")); !errors.Is(err, errFilesBusy) {
		t.Fatalf("full capacity: %v", err)
	}
	for _, req := range requests {
		if ok, err := c.forget(a.state, ctx, epoch, req.OperationID); !ok || err != nil {
			t.Fatalf("forget=%v err=%v", ok, err)
		}
		if ok, err := c.forget(a.state, ctx, epoch, req.OperationID); !ok || err != nil {
			t.Fatalf("duplicate forget=%v err=%v", ok, err)
		}
		if _, err := a.state.startDownload(ctx, epoch, req); !errors.Is(err, errDownload) {
			t.Fatalf("retired nonce replay: %v", err)
		}
	}
	c.mu.Lock()
	jobs, active, retired := len(c.jobs), c.active, len(c.forgotten)
	c.mu.Unlock()
	if jobs != 0 || active != 0 || retired != downloadMaxJobs {
		t.Fatalf("jobs=%d active=%d retired=%d", jobs, active, retired)
	}
	downloadWait(t, downloadStart(t, a, ctx, epoch, c, downloadReq(t, token, "new.mp3")))
}

func TestDownloadForgetRejectsActiveAndCancelledUntilCleanup(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return nil, context.Canceled
	})
	req := downloadReq(t, token, "pending.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	<-entered
	defer func() { close(release); downloadWait(t, j) }()
	assertBusy := func() {
		t.Helper()
		if ok, err := c.forget(a.state, ctx, epoch, req.OperationID); ok || !errors.Is(err, errFilesBusy) {
			t.Fatalf("forgot active task=%v err=%v", ok, err)
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.jobs[req.OperationID] != j || c.active != 1 {
			t.Fatal("active record/permit changed")
		}
	}
	assertBusy()
	if _, err := c.access(a.state, ctx, epoch, req.OperationID, true); err != nil {
		t.Fatal(err)
	}
	assertBusy()
	c.mu.Lock()
	j.state.Done = true // A state snapshot is not proof that cleanup has completed.
	c.mu.Unlock()
	assertBusy()
}

func TestDownloadForgetRejectsForeignOwnerEpochAndRevokedGrant(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, context.Canceled
	})
	req := downloadReq(t, token, "done.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, candidate := range []struct {
		ctx   context.Context
		epoch uint64
	}{{foreign, epoch}, {ctx, epoch + 1}} {
		if ok, err := c.forget(a.state, candidate.ctx, candidate.epoch, req.OperationID); ok || err == nil {
			t.Fatalf("foreign forget=%v err=%v", ok, err)
		}
	}
	var original ownedDirectory
	if err := a.state.main(ctx, func(*mygo.Window) error {
		original = a.state.grants[token]
		delete(a.state.grants, token)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := a.state.main(ctx, func(*mygo.Window) error {
			a.state.grants[token] = original
			return nil
		}); err != nil {
			t.Error(err)
		}
	}()
	if ok, err := c.forget(a.state, ctx, epoch, req.OperationID); ok || !errors.Is(err, errFilesLease) {
		t.Fatalf("revoked forget=%v err=%v", ok, err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.jobs[req.OperationID] != j {
		t.Fatal("unauthorized forget removed task")
	}
}

func TestDownloadForgetNeverEvictsConsumedIDsAtLimit(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, context.Canceled
	})
	req := downloadReq(t, token, "done.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	c.mu.Lock()
	c.forgotten = make(map[string]struct{}, downloadMaxForgotten)
	for i := 0; i < downloadMaxForgotten; i++ {
		c.forgotten[fmt.Sprintf("retired-%d", i)] = struct{}{}
	}
	c.mu.Unlock()
	if ok, err := c.forget(a.state, ctx, epoch, req.OperationID); ok || !errors.Is(err, errFilesBusy) {
		t.Fatalf("limit forget=%v err=%v", ok, err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.forgotten) != downloadMaxForgotten || c.jobs[req.OperationID] != j {
		t.Fatal("limit evicted consumed IDs or removed terminal task")
	}
}
