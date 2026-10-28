//go:build darwin

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
)

func metadataRegisterTestGrant(t *testing.T, f *NativeFiles, ctx context.Context, epoch uint64, dir, name string) LocalFileRef {
	t.Helper()
	handle, err := openDirectoryHandle(dir)
	if err != nil {
		t.Fatal(err)
	}
	token := metadataTestNonce(t)
	if err = f.state.main(ctx, func(_ *mygo.Window) error {
		if f.state.grants == nil {
			f.state.grants = make(map[string]ownedDirectory)
		}
		f.state.grants[token] = ownedDirectory{grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	lease, err := f.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	ref, file, err := f.state.registerLocalFile(lease, name)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	return *ref
}
func metadataWaitTest(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("metadata lifecycle condition did not complete")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestMetadataStaleRegistrationCannotRemoveNewSession(t *testing.T) {
	for _, mode := range []string{"cancel", "dedup"} {
		t.Run(mode, func(t *testing.T) {
			dir := metadataFixture(t, "mp3")
			f, ctx, epoch, ref := metadataTestService(t, dir)
			read := f.ReadMetadata(ctx, epoch, ref)
			oldReq := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256}
			originalMain := f.state.main
			paused := make(chan struct{})
			resume := make(chan struct{})
			var once sync.Once
			var first atomic.Bool
			f.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
				err := originalMain(caller, fn)
				// acquireDirectory has retained A's lease, but Save has not entered c.mu.
				if first.CompareAndSwap(false, true) {
					close(paused)
					<-resume
				}
				return err
			}
			oldDone := make(chan MetadataResult, 1)
			go func() { oldDone <- f.SaveMetadata(ctx, epoch, oldReq) }()
			<-paused
			defer once.Do(func() { close(resume) })
			f.state.dispatch(f.state.revoke)
			session, err := f.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			newRef := metadataRegisterTestGrant(t, f, ctx, session.Epoch, dir, "song.mp3")
			newRead := f.ReadMetadata(ctx, session.Epoch, newRef)
			newReq := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: newRef, SHA256: newRead.SHA256}
			hook := metadataAudioDrain
			defer func() { metadataAudioDrain = hook }()
			var saved MetadataResult
			if mode == "dedup" {
				saved = f.SaveMetadata(ctx, session.Epoch, newReq)
				if saved.Code != "ok" {
					t.Fatal(saved)
				}
			} else {
				entered := make(chan struct{})
				metadataAudioDrain = func(op context.Context, _ *NativeFiles, _ os.FileInfo) (func(), error) {
					close(entered)
					<-op.Done()
					return nil, op.Err()
				}
				done := make(chan MetadataResult, 1)
				go func() { done <- f.SaveMetadata(ctx, session.Epoch, newReq) }()
				<-entered
				once.Do(func() { close(resume) })
				if result := <-oldDone; result.Code != "revoked" {
					t.Fatal(result)
				}
				cancelled := f.CancelMetadata(ctx, session.Epoch, newReq.OperationID)
				if cancelled.Code != "ok" {
					// Let the old implementation's lost worker exit before reporting red.
					f.state.dispatch(f.state.revoke)
					<-done
					t.Fatalf("B cancellation lost after late A: %+v", cancelled)
				}
				if result := <-done; result.Code != "cancelled" {
					t.Fatal(result)
				}
				f.state.main = originalMain
				return
			}
			once.Do(func() { close(resume) })
			if result := <-oldDone; result.Code != "revoked" {
				t.Fatal(result)
			}
			again := f.SaveMetadata(ctx, session.Epoch, newReq)
			if again.Code != "ok" || again.Ref == nil || *again.Ref != *saved.Ref {
				t.Fatalf("B completed dedup lost after late A: %+v", again)
			}
			f.state.main = originalMain
		})
	}
}

func metadataRetainedPictureBytes(c *metadataCoordinator) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var total int64
	for _, job := range c.jobs {
		if job.result.Info != nil {
			for _, p := range job.result.Info.Pictures {
				total += int64(len(p.Data))
			}
		}
	}
	return total
}
func TestMetadataCompletedCacheBudgetBeforeRename(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	name := filepath.Join(dir, "song.mp3")
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	pictures := []metadata.Picture{{MIME: "image/png", Type: 3, Data: bytes.Repeat([]byte{42}, 6<<20)}}
	var firstReq MetadataSaveRequest
	var firstResult MetadataResult
	limited := false
	for i := 0; i < 14; i++ {
		title := "bounded cover history"
		patch := metadata.Patch{Title: &title}
		if i == 0 {
			patch.Pictures = &pictures
		}
		req := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256, Patch: patch}
		before, _ := os.Stat(name)
		result := f.SaveMetadata(ctx, epoch, req)
		if result.Code == "limit" {
			if result.Committed {
				t.Fatal("budget rejection happened after commit")
			}
			after, _ := os.Stat(name)
			if !os.SameFile(before, after) {
				t.Fatal("budget rejection renamed original")
			}
			repeat := f.SaveMetadata(ctx, epoch, req)
			if repeat.Code != "limit" || repeat.Committed {
				t.Fatalf("limit tombstone lost %+v", repeat)
			}
			limited = true
			break
		}
		if result.Code != "ok" {
			t.Fatal(result)
		}
		if i == 0 {
			firstReq = req
			firstResult = result
		}
		c := metadataCoordinatorFor(&f.state)
		c.mu.Lock()
		accounted := c.cachedBytes
		c.mu.Unlock()
		if accounted > metadataCacheBytes {
			t.Fatalf("coordinator budget overdrawn %d", accounted)
		}
		if size := metadataRetainedPictureBytes(c); size > 64<<20 {
			t.Fatalf("cached picture bytes exceed 64MiB: %d", size)
		}
		ref = *result.Ref
		read = result
	}
	if !limited {
		t.Fatal("large-cover history never reached cache byte budget")
	}
	before, _ := os.Stat(name)
	repeat := f.SaveMetadata(ctx, epoch, firstReq)
	after, _ := os.Stat(name)
	if repeat.Code != "ok" || repeat.Ref == nil || *repeat.Ref != *firstResult.Ref || !os.SameFile(before, after) {
		t.Fatalf("historic ID wrote again or lost original result: %+v", repeat)
	}
}
func TestMetadataRevokeDropsResultsWithoutDroppingActiveIdentity(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256})
	if result.Code != "ok" {
		t.Fatal(result)
	}
	c := metadataCoordinatorFor(&f.state)
	hook := metadataAudioDrain
	defer func() { metadataAudioDrain = hook }()
	entered := make(chan struct{})
	leave := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(leave) })
	metadataAudioDrain = func(op context.Context, _ *NativeFiles, _ os.FileInfo) (func(), error) {
		close(entered)
		<-op.Done()
		<-leave
		return nil, op.Err()
	}
	done := make(chan MetadataResult, 1)
	go func() {
		done <- f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: *result.Ref, SHA256: result.SHA256})
	}()
	<-entered
	if err := f.RevokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
		t.Fatal(err)
	}
	// No further Save occurs: the independent grant watcher must clear results.
	deadline := time.Now().Add(time.Second)
	cleared := false
	for time.Now().Before(deadline) {
		c.mu.Lock()
		// Independent retirement callbacks may run in either order. Wait for
		// both jobs and their accounting before checking the surviving IO.
		cleared = len(c.jobs) == 0 && c.cachedBytes == 0 && c.resultBytes == 0
		slots := len(c.slots)
		bytes, resultBytes, active := c.cachedBytes, c.resultBytes, c.active
		c.mu.Unlock()
		if cleared {
			if slots != 1 {
				t.Fatal("active IO identity slot dismantled during revoke")
			}
			if bytes != 0 || resultBytes != 0 || active != 1 {
				t.Fatalf("retirement leaked budget or released IO permit: %d %d %d", bytes, resultBytes, active)
			}
			info, _ := os.Stat(filepath.Join(dir, "song.mp3"))
			wait, cancel := context.WithTimeout(context.Background(), time.Millisecond)
			_, err := c.lock(wait, info)
			cancel()
			if err != context.DeadlineExceeded {
				t.Fatalf("retired IO identity no longer excludes new worker: %v", err)
			}
			break
		}
		time.Sleep(time.Millisecond)
	}
	once.Do(func() { close(leave) })
	<-done
	if !cleared {
		t.Fatal("grant revoke retained completed metadata without another Save")
	}
}
func TestMetadataActiveSaveLimitAndRelease(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	source, _ := os.ReadFile(filepath.Join(dir, "song.mp3"))
	for _, name := range []string{"two.mp3", "three.mp3"} {
		if err := os.WriteFile(filepath.Join(dir, name), source, 0600); err != nil {
			t.Fatal(err)
		}
	}
	f, ctx, epoch, one := metadataTestService(t, dir)
	two := metadataRegisterTestGrant(t, f, ctx, epoch, dir, "two.mp3")
	three := metadataRegisterTestGrant(t, f, ctx, epoch, dir, "three.mp3")
	firstInfo, _ := os.Stat(filepath.Join(dir, "song.mp3"))
	secondInfo, _ := os.Stat(filepath.Join(dir, "two.mp3"))
	hook := metadataAudioDrain
	defer func() { metadataAudioDrain = hook }()
	entered := make(chan struct{}, 2)
	leave := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(leave) })
	metadataAudioDrain = func(op context.Context, _ *NativeFiles, info os.FileInfo) (func(), error) {
		if os.SameFile(info, firstInfo) || os.SameFile(info, secondInfo) {
			entered <- struct{}{}
			select {
			case <-leave:
			case <-op.Done():
				return nil, op.Err()
			}
		}
		return func() {}, nil
	}
	done := make(chan MetadataResult, 2)
	for _, ref := range []LocalFileRef{one, two} {
		read := f.ReadMetadata(ctx, epoch, ref)
		req := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256}
		go func() { done <- f.SaveMetadata(ctx, epoch, req) }()
	}
	<-entered
	<-entered
	read := f.ReadMetadata(ctx, epoch, three)
	id := metadataTestNonce(t)
	rejected := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: three, SHA256: read.SHA256})
	once.Do(func() { close(leave) })
	a, b := <-done, <-done
	if rejected.Code != "limit" || rejected.Committed {
		t.Fatalf("third concurrent Save was not rejected: %+v", rejected)
	}
	if a.Code != "ok" || b.Code != "ok" {
		t.Fatalf("active saves failed %+v %+v", a, b)
	}
	retry := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: three, SHA256: read.SHA256})
	if retry.Code != "ok" {
		t.Fatalf("active permit leaked %+v", retry)
	}
	if repeated := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: three, SHA256: read.SHA256}); repeated.Code != "limit" {
		t.Fatalf("limit ID lost tombstone %+v", repeated)
	}
}

func TestMetadataCancelReleasesReservationBeforeWorkerExit(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	c := metadataCoordinatorFor(&f.state)
	hook := metadataAudioDrain
	defer func() { metadataAudioDrain = hook }()
	entered := make(chan struct{})
	leave := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(leave) })
	metadataAudioDrain = func(op context.Context, _ *NativeFiles, _ os.FileInfo) (func(), error) {
		close(entered)
		<-op.Done()
		<-leave
		return nil, op.Err()
	}
	id := metadataTestNonce(t)
	pictures := []metadata.Picture{{MIME: "image/png", Type: 3, Data: bytes.Repeat([]byte{1}, 1<<20)}}
	done := make(chan MetadataResult, 1)
	go func() {
		done <- f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: ref, SHA256: read.SHA256, Patch: metadata.Patch{Pictures: &pictures}})
	}()
	<-entered
	c.mu.Lock()
	reserved := c.cachedBytes
	c.mu.Unlock()
	if reserved < 1<<20 {
		t.Fatal("save reached drain without reserving its cover result")
	}
	if result := f.CancelMetadata(ctx, epoch, id); result.Code != "ok" {
		t.Fatal(result)
	}
	c.mu.Lock()
	remaining, active := c.cachedBytes, c.active
	c.mu.Unlock()
	once.Do(func() { close(leave) })
	result := <-done
	if remaining != metadataJobBaseBytes || active != 1 {
		t.Fatalf("cancel failed to release reservation while preserving active IO: bytes=%d active=%d", remaining, active)
	}
	if result.Code != "cancelled" {
		t.Fatal(result)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active != 0 || c.resultBytes != 0 || c.jobs[id].result.Info != nil {
		t.Fatal("cancelled worker leaked permit or content")
	}
}
func TestMetadataCompletedWatchLifetime(t *testing.T) {
	for _, mode := range []string{"session", "owner"} {
		t.Run(mode, func(t *testing.T) {
			dir := metadataFixture(t, "mp3")
			f, ctx, epoch, ref := metadataTestService(t, dir)
			var cancel context.CancelFunc
			if mode == "owner" {
				owner, stop := context.WithCancel(ctx)
				cancel = stop
				defer cancel()
				original := f.state.main
				originalOwner := ctx
				f.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
					if caller == owner {
						return original(originalOwner, fn)
					}
					return original(caller, fn)
				}
				session, err := f.Begin(owner)
				if err != nil {
					t.Fatal(err)
				}
				ctx, epoch = owner, session.Epoch
				ref = metadataRegisterTestGrant(t, f, ctx, epoch, dir, "song.mp3")
			}
			read := f.ReadMetadata(ctx, epoch, ref)
			id := metadataTestNonce(t)
			result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: ref, SHA256: read.SHA256})
			if result.Code != "ok" {
				t.Fatal(result)
			}
			c := metadataCoordinatorFor(&f.state)
			c.mu.Lock()
			job := c.jobs[id]
			c.mu.Unlock()
			// Individual lease.Release has already occurred. Completed dedup must survive.
			if repeat := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: ref, SHA256: read.SHA256}); repeat.Code != "ok" {
				t.Fatal(repeat)
			}
			if mode == "owner" {
				cancel()
			} else {
				f.state.dispatch(f.state.revoke)
				if _, err := f.Begin(ctx); err != nil {
					t.Fatal(err)
				}
			}
			metadataWaitTest(t, func() bool {
				c.mu.Lock()
				defer c.mu.Unlock()
				return len(c.jobs) == 0 && c.cachedBytes == 0 && c.resultBytes == 0 && job.result.Info == nil && job.owner == nil && job.ref == (LocalFileRef{})
			})
		})
	}
}
