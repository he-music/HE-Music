package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func libraryTestStore(t *testing.T) *libraryDirectoryStore {
	t.Helper()
	return &libraryDirectoryStore{path: filepath.Join(t.TempDir(), "local-library-directories.json")}
}

func libraryTestCanonical(t *testing.T, path string) string {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func TestLibraryPersistenceRestartFreshGrantLeaseAndRef(t *testing.T) {
	store := libraryTestStore(t)
	actor, ctx, epoch := newFileTestActor(t)
	directory := libraryTestCanonical(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(directory, "song.mp3"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	actor.state.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) {
		return []string{directory}, nil
	}}
	selected, err := actor.state.chooseDirectory(ctx, epoch)
	if err != nil || selected.Grant == nil {
		t.Fatalf("selection: %+v %v", selected, err)
	}
	if err := store.update(selected.Grant.DisplayPath, true); err != nil {
		t.Fatal(err)
	}
	oldLease, err := actor.state.acquireDirectory(ctx, epoch, selected.Grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	oldRef, oldFile, err := actor.state.registerLocalFile(oldLease, "song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	oldFile.Close()
	oldLease.Release()
	if err := actor.state.teardown(ctx, epoch); err != nil {
		t.Fatal(err)
	}
	actor.state.cleanup.Wait()

	// A different store instance and native state simulate process restart.
	restarted := &libraryDirectoryStore{path: store.path}
	freshActor, freshContext, freshEpoch := newFileTestActor(t)
	// Epochs are process-local counters and may repeat across process restart.
	// Force a new owner generation as well to prove no epoch is read from disk.
	if err := freshActor.state.teardown(freshContext, freshEpoch); err != nil {
		t.Fatal(err)
	}
	freshSession, err := freshActor.state.session(freshContext)
	if err != nil {
		t.Fatal(err)
	}
	freshEpoch = freshSession.Epoch
	result, err := freshActor.state.restoreDirectories(freshContext, freshEpoch, restarted)
	if err != nil || len(result.Grants) != 1 || len(result.Unavailable) != 0 {
		t.Fatalf("restore: %+v %v", result, err)
	}
	grant := result.Grants[0]
	if grant.Token == selected.Grant.Token || grant.Epoch != freshEpoch || grant.Epoch == epoch || grant.DisplayPath != directory {
		t.Fatalf("grant not fresh: %+v", grant)
	}
	if _, err := freshActor.state.acquireDirectory(freshContext, freshEpoch, selected.Grant.Token); !errors.Is(err, errFilesToken) {
		t.Fatal("old token survived restart")
	}
	lease, err := freshActor.state.acquireDirectory(freshContext, freshEpoch, grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	ref, file, err := freshActor.state.registerLocalFile(lease, "song.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if *ref == *oldRef || ref.GrantToken != grant.Token || freshActor.state.checkLease(lease) != nil {
		t.Fatal("fresh lease/ref unavailable")
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{selected.Grant.Token, grant.Token, "epoch", "root", "fileId", "grantToken"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("persisted transient capability: %s", secret)
		}
	}
	info, err := os.Stat(store.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private mode: %v %v", info, err)
	}
	repeated, err := freshActor.state.restoreDirectories(freshContext, freshEpoch, restarted)
	if err != nil || len(repeated.Grants) != 1 || repeated.Grants[0] != grant || len(freshActor.state.grants) != 1 {
		t.Fatalf("restore not idempotent: %+v %v", repeated, err)
	}
	encoded, err := json.Marshal(result)
	if err != nil || !strings.Contains(string(encoded), `"grants":`) || !strings.Contains(string(encoded), `"unavailable":[]`) {
		t.Fatalf("typed JSON contract: %s %v", encoded, err)
	}
}

func TestLibraryPersistenceMissingForgetAndCanonicalOverlap(t *testing.T) {
	store := libraryTestStore(t)
	parent := libraryTestCanonical(t, t.TempDir())
	child := filepath.Join(parent, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{child, child, parent, child} {
		if err := store.update(path, true); err != nil {
			t.Fatal(err)
		}
	}
	paths, err := store.snapshot()
	if err != nil || len(paths) != 1 || paths[0] != parent {
		t.Fatalf("canonical overlap: %v %v", paths, err)
	}
	missing := filepath.Join(libraryTestCanonical(t, t.TempDir()), "removed")
	if err := os.Mkdir(missing, 0700); err != nil {
		t.Fatal(err)
	}
	if err := store.update(missing, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	actor, ctx, epoch := newFileTestActor(t)
	result, err := actor.state.restoreDirectories(ctx, epoch, store)
	if err != nil || len(result.Grants) != 1 || len(result.Unavailable) != 1 || result.Unavailable[0] != missing {
		t.Fatalf("missing restore: %+v %v", result, err)
	}
	paths, err = store.snapshot()
	if err != nil || len(paths) != 2 {
		t.Fatalf("missing silently removed: %v %v", paths, err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch, missing, store); err != nil {
		t.Fatal(err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch, parent, store); err != nil {
		t.Fatal(err)
	}
	paths, err = (&libraryDirectoryStore{path: store.path}).snapshot()
	if err != nil || len(paths) != 0 || len(actor.state.grants) != 1 {
		t.Fatalf("forget must affect only saved records: %v %v", paths, err)
	}
	if err := actor.state.forgetSavedDirectory(ctx, epoch, filepath.Join(parent, "never-selected"), store); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryPersistenceCorruptionNeverOverwritten(t *testing.T) {
	for name, data := range map[string]string{
		"broken": "{", "null": "null", "null-paths": `{"version":1,"directories":null}`,
		"unknown":       `{"version":1,"directories":[],"token":"bad"}`,
		"version":       `{"version":2,"directories":[]}`,
		"duplicate-key": `{"version":1,"version":1,"directories":[]}`,
		"relative":      `{"version":1,"directories":["relative"]}`,
		"trailing":      `{"version":1,"directories":[]} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := libraryTestStore(t)
			if err := os.WriteFile(store.path, []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			actor, ctx, epoch := newFileTestActor(t)
			if _, err := actor.state.restoreDirectories(ctx, epoch, store); !errors.Is(err, errLibraryPersistence) {
				t.Fatalf("corrupt restore accepted: %v", err)
			}
			if err := store.update(libraryTestCanonical(t, t.TempDir()), true); !errors.Is(err, errLibraryPersistence) {
				t.Fatalf("corrupt save accepted: %v", err)
			}
			if err := actor.state.forgetSavedDirectory(ctx, epoch, "/missing", store); !errors.Is(err, errLibraryPersistence) {
				t.Fatalf("corrupt forget accepted: %v", err)
			}
			after, err := os.ReadFile(store.path)
			if err != nil || string(after) != data || len(actor.state.grants) != 0 {
				t.Fatalf("corrupt source overwritten: %q %v", after, err)
			}
		})
	}
}

func TestLibraryPersistenceRestoreRejectsBusyStaleCancelledRevokedAndForeign(t *testing.T) {
	for _, scenario := range []string{"busy", "stale", "cancelled", "revoked", "foreign", "parent-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			store := libraryTestStore(t)
			if err := store.update(libraryTestCanonical(t, t.TempDir()), true); err != nil {
				t.Fatal(err)
			}
			actor, ctx, epoch := newFileTestActor(t)
			want := errFilesOwner
			switch scenario {
			case "busy":
				op, err := actor.state.begin(ctx, epoch)
				if err != nil {
					t.Fatal(err)
				}
				defer actor.state.finish(op)
				want = errFilesBusy
			case "stale":
				epoch++
			case "foreign":
				ctx = context.Background()
			default:
				// The second actor entry occurs after disk load. Invalidation here
				// demonstrates that IO completion cannot restore an obsolete owner.
				main := actor.state.main
				calls := 0
				actor.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
					calls++
					if calls == 2 {
						switch scenario {
						case "cancelled":
							actor.ready = false
						case "revoked":
							actor.state.dispatch(actor.state.revoke)
						case "parent-replaced":
							actor.parent = &mygo.Window{}
						}
					}
					return main(caller, fn)
				}
			}
			if _, err := actor.state.restoreDirectories(ctx, epoch, store); !errors.Is(err, want) {
				t.Fatalf("restore accepted %s: %v", scenario, err)
			}
			if len(actor.state.grants) != 0 {
				t.Fatal("invalid restore created a grant")
			}
		})
	}
}

func TestLibraryPersistenceGenerateNoIOAndUnconfigured(t *testing.T) {
	store := libraryTestStore(t)
	if err := os.WriteFile(store.path, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MYGO_GENERATE", "1")
	if _, err := store.snapshot(); !errors.Is(err, errLibraryPersistence) {
		t.Fatal("binding generation read disk")
	}
	if err := store.update("/selected", true); !errors.Is(err, errLibraryPersistence) {
		t.Fatal("binding generation wrote disk")
	}
	data, err := os.ReadFile(store.path)
	if err != nil || string(data) != "untouched" {
		t.Fatal("binding generation changed disk")
	}
	if _, err := (&libraryDirectoryStore{}).snapshot(); !errors.Is(err, errLibraryPersistence) {
		t.Fatal("unconfigured store accepted")
	}
}
