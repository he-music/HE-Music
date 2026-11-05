package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func metadataTestService(t *testing.T, dir string) (*NativeFiles, context.Context, uint64, LocalFileRef) {
	t.Helper()
	actor, ctx, epoch := newFileTestActor(t)
	f := &NativeFiles{state: nativeFilesState{main: actor.state.main, dispatch: actor.state.dispatch, owner: ctx, epoch: epoch}}
	actor.state = &f.state
	handle, err := openDirectoryHandle(dir)
	if err != nil {
		t.Fatal(err)
	}
	token, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	requireTestNoError(t, f.state.main(ctx, func(_ *mygo.Window) error {
		f.state.grants = map[string]ownedDirectory{token: {grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle}}
		return nil
	}))
	lease, err := f.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	ref, file, err := f.state.registerLocalFile(lease, "song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	lease.Release()
	t.Cleanup(func() {
		if err := f.shutdownLocalAudio(); err != nil {
			t.Error(err)
		}
		f.state.dispatch(f.state.revoke)
		f.state.cleanup.Wait()
		metadataCoordinators.Lock()
		delete(metadataCoordinators.entries, &f.state)
		metadataCoordinators.Unlock()
	})
	return f, ctx, epoch, *ref
}

func metadataTestNonce(t *testing.T) string {
	t.Helper()
	s, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMetadataIdentityLockCancelAndTimeout(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	if err := os.WriteFile(a, []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(a, b); err != nil {
		t.Fatal(err)
	}
	ai, _ := os.Stat(a)
	bi, _ := os.Stat(b)
	c := &metadataCoordinator{}
	unlock, err := c.lock(context.Background(), ai)
	if err != nil {
		t.Fatal(err)
	}
	for _, timeout := range []bool{false, true} {
		var ctx context.Context
		var cancel context.CancelFunc
		if timeout {
			ctx, cancel = context.WithTimeout(context.Background(), time.Millisecond)
		} else {
			ctx, cancel = context.WithCancel(context.Background())
			cancel()
		}
		_, err = c.lock(ctx, bi)
		cancel()
		if timeout && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if !timeout && !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	}
	unlock()
	release, err := c.lock(context.Background(), bi)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestMetadataLimitAndRevokedRead(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "song.mp3")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate((33 << 20)); err != nil {
		t.Fatal(err)
	}
	file.Close()
	f, ctx, epoch, ref := metadataTestService(t, dir)
	if result := f.ReadMetadata(ctx, epoch, ref); result.Code == "limit" {
		t.Fatalf("%+v", result)
	}
	if err = f.RevokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
		t.Fatal(err)
	}
	if result := f.ReadMetadata(ctx, epoch, ref); result.Code != "revoked" {
		t.Fatalf("%+v", result)
	}
}

func TestMetadataForeignCancelAndBoundedJobs(t *testing.T) {
	dir := t.TempDir()
	requireTestNoError(t, os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("not audio"), 0o600))
	f, ctx, epoch, ref := metadataTestService(t, dir)
	foreign := t.Context()
	if result := f.CancelMetadata(foreign, epoch, "anything"); result.Code != "revoked" {
		t.Fatal(result)
	}
	c := metadataCoordinatorFor(&f.state)
	c.owner, c.epoch = ctx, epoch
	for range 256 {
		c.jobs[metadataTestNonce(t)] = &metadataJob{owner: ctx, epoch: epoch, bytes: metadataJobBaseBytes}
	}
	c.cachedBytes = metadataMaxJobs * metadataJobBaseBytes
	req := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: "0000000000000000000000000000000000000000000000000000000000000000"}
	if result := f.SaveMetadata(ctx, epoch, req); result.Code != "limit" {
		t.Fatal(result)
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		file, _ := os.Open(filepath.Join(dir, "song.mp3"))
		defer file.Close()
		if metadataCheckAttributes(file) == nil {
			t.Fatal("platform silently accepted attributes")
		}
	}
}
