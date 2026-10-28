package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func TestValidateLocalRelativePathRejectsTransportEscapes(t *testing.T) {
	for _, path := range []string{"", ".", "..", "a/../b", "/tmp/song.mp3", `a\\song.mp3`, "a:\\song.mp3", "a\x00b", "a//b", "a/"} {
		if err := validateLocalRelativePath(path); !errors.Is(err, errFilesPath) {
			t.Fatalf("path %q accepted: %v", path, err)
		}
	}
	if err := validateLocalRelativePath("album/song.mp3"); err != nil {
		t.Fatalf("valid path rejected: %v", err)
	}
}

func TestDirectoryLeaseFileRefAndCommitGate(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	rootPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootPath, "song.mp3"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(rootPath, "subdir"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootPath, "subdir", "song.mp3"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("subdir", filepath.Join(rootPath, "alias")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	handle, err := openDirectoryHandle(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	token, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	actor.state.main(ctx, func(parent *mygo.Window) error {
		actor.state.grants = map[string]ownedDirectory{
			token: {grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle},
		}
		return nil
	})

	lease, err := actor.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := openGrantedRegular(lease, "alias/song.mp3"); !errors.Is(err, errFilesPath) {
		t.Fatalf("symlink directory accepted: %v", err)
	}
	ref, file, err := actor.state.registerLocalFile(lease, "song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	resolved, err := actor.state.resolveLocalFile(lease, *ref)
	if err != nil {
		t.Fatal(err)
	}
	resolved.Close()

	commit := newFileCommit()
	t.Cleanup(func() { actor.state.finishFileCommit(commit) })
	if err := actor.state.claimFileCommit(lease, commit); err != nil {
		t.Fatal(err)
	}
	actor.state.dispatch(actor.state.revoke)
	lease.Release()
	actor.state.cleanup.Wait()
	if _, err := handle.root.Stat("song.mp3"); err != nil {
		t.Fatalf("claim lost Root before finish: %v", err)
	}
	actor.state.finishFileCommit(commit)
	actor.state.cleanup.Wait()
	if commit.phase.Load() != fileCommitFinished {
		t.Fatalf("claimed commit phase changed to %d", commit.phase.Load())
	}
	if lease.Context().Err() == nil {
		t.Fatal("revoked lease context is still active")
	}

	next, err := actor.state.session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := actor.state.acquireDirectory(ctx, next.Epoch, token); !errors.Is(err, errFilesToken) {
		t.Fatalf("revoked token accepted: %v", err)
	}
}

func TestDirectoryLeaseReleaseIsIdempotentAndRevocationWinsBeforeClaim(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	rootPath := t.TempDir()
	handle, err := openDirectoryHandle(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	token, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	actor.state.main(ctx, func(parent *mygo.Window) error {
		actor.state.grants = map[string]ownedDirectory{
			token: {grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle},
		}
		return nil
	})
	lease, err := actor.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	actor.state.dispatch(actor.state.revoke)
	commit := newFileCommit()
	if err := actor.state.claimFileCommit(lease, commit); !errors.Is(err, errFilesLease) {
		t.Fatalf("revoked lease claimed commit: %v", err)
	}
	lease.Release()
	lease.Release()
	actor.state.cleanup.Wait()
}
