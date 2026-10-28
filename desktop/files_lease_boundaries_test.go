package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func grantedLeaseFixture(t *testing.T) (*fileTestActor, context.Context, uint64, *directoryLease, string) {
	t.Helper()
	actor, ctx, epoch := newFileTestActor(t)
	dir := t.TempDir()
	handle, err := openDirectoryHandle(dir)
	if err != nil {
		t.Fatal(err)
	}
	token, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.state.main(ctx, func(*mygo.Window) error {
		actor.state.grants = map[string]ownedDirectory{
			token: {grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	lease, err := actor.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lease.Release)
	return actor, ctx, epoch, lease, dir
}

func TestLocalFileOpenRejectsUnvalidatedPath(t *testing.T) {
	_, _, _, lease, dir := grantedLeaseFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("test-only audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"./song.mp3", "child/../song.mp3", "song.mp3/", "song.mp3:ads"} {
		file, _, err := openGrantedRegular(lease, path)
		if file != nil {
			file.Close()
		}
		if !errors.Is(err, errFilesPath) {
			t.Errorf("unvalidated path %q accepted: %v", path, err)
		}
	}
}

func TestLocalFileReferencesRejectForgeryAndReplacement(t *testing.T) {
	actor, _, _, lease, dir := grantedLeaseFixture(t)
	path := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	ref, file, err := actor.state.registerLocalFile(lease, "song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	for _, field := range []string{"grant", "version", "file", "relative"} {
		forged := *ref
		switch field {
		case "grant":
			forged.GrantToken = "forged"
		case "version":
			forged.Version = "forged"
		case "file":
			forged.FileID = "forged"
		case "relative":
			forged.RelativePath = "other.mp3"
		}
		if file, err := actor.state.resolveLocalFile(lease, forged); err == nil {
			file.Close()
			t.Fatalf("forged %s accepted", field)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "replacement"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "replacement"), path); err != nil {
		t.Fatal(err)
	}
	if file, err := actor.state.resolveLocalFile(lease, *ref); !errors.Is(err, errFilesChanged) {
		if file != nil {
			file.Close()
		}
		t.Fatalf("replaced inode resolved with old ref: %v", err)
	}
}

func TestDirectoryLeaseRejectsForeignStaleAndUnknownGrant(t *testing.T) {
	actor, ctx, epoch, lease, _ := grantedLeaseFixture(t)
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, request := range []struct {
		caller context.Context
		epoch  uint64
		token  string
	}{
		{foreign, epoch, lease.token},
		{ctx, 0, lease.token},
		{ctx, epoch + 1, lease.token},
		{ctx, epoch, "00"},
		{ctx, epoch, "not-a-token"},
	} {
		if unexpected, err := actor.state.acquireDirectory(request.caller, request.epoch, request.token); err == nil {
			unexpected.Release()
			t.Fatal("invalid directory capability accepted")
		}
	}
	if actor.state.busy != nil {
		t.Fatal("directory lease occupied the picker slot")
	}
}

func TestFileCommitRetainsRootAndFinishesOnlyOnce(t *testing.T) {
	actor, _, _, lease, _ := grantedLeaseFixture(t)
	commit := newFileCommit()
	t.Cleanup(func() { actor.state.finishFileCommit(commit) })
	if err := actor.state.claimFileCommit(lease, commit); err != nil {
		t.Fatal(err)
	}
	if err := actor.state.claimFileCommit(lease, commit); !errors.Is(err, errFilesBusy) {
		t.Fatalf("duplicate claim accepted: %v", err)
	}
	actor.state.dispatch(actor.state.revoke)
	lease.Release()
	actor.state.cleanup.Wait()
	if _, err := lease.handle.root.Stat("."); err != nil {
		t.Fatalf("Root closed while authorized commit is unfinished: %v", err)
	}
	actor.state.finishFileCommit(commit)
	actor.state.finishFileCommit(commit)
	actor.state.cleanup.Wait()
	if _, err := lease.handle.root.Stat("."); err == nil {
		t.Fatal("retired Root remains open after the last reference")
	}
}

func TestLocalFileParentReplacementInvalidatesRef(t *testing.T) {
	actor, _, _, lease, dir := grantedLeaseFixture(t)
	parent := filepath.Join(dir, "album")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "song.mp3"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	ref, file, err := actor.state.registerLocalFile(lease, "album/song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	duplicate, file, err := actor.state.registerLocalFile(lease, "album/song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if *duplicate != *ref || len(actor.state.fileEntries) != 1 {
		t.Fatal("unchanged registration churned references")
	}
	if err := os.Rename(parent, filepath.Join(dir, "old-album")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "old-album", "song.mp3"), filepath.Join(parent, "song.mp3")); err != nil {
		t.Skipf("hard link unavailable: %v", err)
	}
	if file, err := actor.state.resolveLocalFile(lease, *ref); !errors.Is(err, errFilesChanged) {
		if file != nil {
			file.Close()
		}
		t.Fatalf("new parent with same file inode accepted: %v", err)
	}
}

func TestOwnerReplacementKeepsRootUntilWorkerReleasesLease(t *testing.T) {
	actor, _, _, lease, _ := grantedLeaseFixture(t)
	owner, cancel := context.WithCancel(context.Background())
	actor.mu.Lock()
	actor.owner = owner
	actor.mu.Unlock()
	session, err := actor.state.session(owner)
	if err != nil {
		t.Fatal(err)
	}
	oldHandle := lease.handle
	if !oldHandle.retired.Load() {
		t.Fatal("owner replacement left old grant active")
	}
	if _, err := oldHandle.root.Stat("."); err != nil {
		t.Fatalf("old worker lost Root before release: %v", err)
	}
	lease.Release()
	actor.state.cleanup.Wait()
	cancel()
	if _, err := actor.state.acquireDirectory(owner, session.Epoch, lease.token); err == nil {
		t.Fatal("cancelled owner acquired old grant")
	}
}
