package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/egoist/mygo"
)

func TestLibraryPersistencePendingReadBusyAndContextCancellation(t *testing.T) {
	store := libraryTestStore(t)
	if err := store.update(libraryTestCanonical(t, t.TempDir()), true); err != nil {
		t.Fatal(err)
	}
	actor, originalContext, epoch := newFileTestActor(t)
	ctx, cancel := context.WithCancel(originalContext)
	defer cancel()
	actor.state.dispatch(func() { actor.owner = ctx; actor.state.owner = ctx })
	begun := make(chan struct{})
	var began sync.Once
	main := actor.state.main
	actor.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
		err := main(caller, fn)
		began.Do(func() { close(begun) })
		return err
	}
	store.mu.Lock()
	done := make(chan error, 1)
	go func() { _, err := actor.state.restoreDirectories(ctx, epoch, store); done <- err }()
	<-begun
	if _, err := actor.state.restoreDirectories(ctx, epoch, store); !errors.Is(err, errFilesBusy) {
		t.Errorf("pending disk read did not hold busy: %v", err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch, "/missing", store); !errors.Is(err, errFilesBusy) {
		t.Errorf("forget bypassed busy: %v", err)
	}
	cancel()
	store.mu.Unlock()
	if err := <-done; !errors.Is(err, errFilesOwner) {
		t.Fatalf("cancelled restore committed: %v", err)
	}
	if len(actor.state.grants) != 0 {
		t.Fatal("cancelled read registered a directory")
	}
}

func TestLibraryPersistenceRegistrationRechecksOwnerEpochAndParent(t *testing.T) {
	for _, scenario := range []string{"owner", "epoch", "parent", "revoked"} {
		t.Run(scenario, func(t *testing.T) {
			store := libraryTestStore(t)
			if err := store.update(libraryTestCanonical(t, t.TempDir()), true); err != nil {
				t.Fatal(err)
			}
			actor, ctx, epoch := newFileTestActor(t)
			main := actor.state.main
			calls := 0
			actor.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
				calls++
				if calls == 4 {
					// Root and ancestor identities have been captured off-main;
					// invalidate immediately before the registration actor entry.
					actor.state.dispatch(func() {
						switch scenario {
						case "owner":
							actor.owner = context.Background()
						case "epoch":
							actor.state.epoch++
						case "parent":
							actor.parent = &mygo.Window{}
						case "revoked":
							actor.state.revoke()
						}
					})
				}
				return main(caller, fn)
			}
			if _, err := actor.state.restoreDirectories(ctx, epoch, store); !errors.Is(err, errFilesOwner) || calls < 4 {
				t.Fatalf("obsolete registration accepted: %v (%d actor calls)", err, calls)
			}
			if len(actor.state.grants) != 0 {
				t.Fatal("obsolete registration leaked grant")
			}
		})
	}
}

func TestLibraryPersistenceRestoreExistingCanonicalDirectory(t *testing.T) {
	store := libraryTestStore(t)
	actor, ctx, epoch := newFileTestActor(t)
	directory := libraryTestCanonical(t, t.TempDir())
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(directory, alias); err != nil {
		t.Fatal(err)
	}
	actor.state.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) {
		return []string{alias}, nil
	}}
	selected, err := actor.state.chooseDirectory(ctx, epoch)
	if err != nil || selected.Grant == nil || selected.Grant.DisplayPath != directory {
		t.Fatalf("canonical selection: %+v %v", selected, err)
	}
	if err := store.update(selected.Grant.DisplayPath, true); err != nil {
		t.Fatal(err)
	}
	result, err := actor.state.restoreDirectories(ctx, epoch, store)
	if err != nil || len(result.Grants) != 1 || result.Grants[0] != *selected.Grant || len(actor.state.grants) != 1 {
		t.Fatalf("existing canonical grant duplicated: %+v %v", result, err)
	}
	if err := actor.state.revokeDirectory(ctx, epoch, selected.Grant.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.update(selected.Grant.DisplayPath, false); err != nil {
		t.Fatal(err)
	}
	restored, err := actor.state.restoreDirectories(ctx, epoch, store)
	if err != nil || len(restored.Grants) != 0 || len(actor.state.grants) != 0 {
		t.Fatalf("forgotten revocation restored: %+v %v", restored, err)
	}
}

func TestLibraryPersistenceForgetChecksSessionAndCannotAuthorize(t *testing.T) {
	store := libraryTestStore(t)
	actor, ctx, epoch := newFileTestActor(t)
	path := libraryTestCanonical(t, t.TempDir())
	if err := store.update(path, true); err != nil {
		t.Fatal(err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch+1, path, store); !errors.Is(err, errFilesOwner) {
		t.Fatalf("stale forget accepted: %v", err)
	}
	if err := actor.state.forgetSavedDirectory(context.Background(), epoch, path, store); !errors.Is(err, errFilesOwner) {
		t.Fatalf("foreign forget accepted: %v", err)
	}
	paths, err := store.snapshot()
	if err != nil || len(paths) != 1 {
		t.Fatalf("invalid forget changed records: %v %v", paths, err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch, path, store); err != nil || len(actor.state.grants) != 0 {
		t.Fatalf("forget authorized path: %v", err)
	}
}
