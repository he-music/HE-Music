package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"
)

type fakeFilePicker struct {
	open func(mygo.OpenDialogOptions) ([]string, error)
	save func(mygo.SaveDialogOptions) (string, error)
}

func (p fakeFilePicker) Open(options mygo.OpenDialogOptions) ([]string, error) {
	return p.open(options)
}
func (p fakeFilePicker) Save(options mygo.SaveDialogOptions) (string, error) { return p.save(options) }

type fileTestActor struct {
	mu     sync.Mutex
	ready  bool
	owner  context.Context
	parent *mygo.Window
	state  *nativeFilesState
}

func newFileTestActor(t *testing.T) (*fileTestActor, context.Context, uint64) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	actor := &fileTestActor{owner: ctx, ready: true, parent: &mygo.Window{}}
	state := &nativeFilesState{}
	state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
		actor.mu.Lock()
		defer actor.mu.Unlock()
		if !actor.ready || caller != actor.owner || caller.Err() != nil {
			return errFilesOwner
		}
		return fn(actor.parent)
	}
	state.dispatch = func(fn func()) { actor.mu.Lock(); defer actor.mu.Unlock(); fn() }
	state.picker = fakeFilePicker{
		open: func(mygo.OpenDialogOptions) ([]string, error) { return nil, nil },
		save: func(mygo.SaveDialogOptions) (string, error) { return "", nil },
	}
	// An explicit temp directory, never App.Path or a user's default directory.
	defaultDir := t.TempDir()
	state.defaultPath = func(DefaultDirectoryKind) (string, error) { return defaultDir, nil }
	actor.state = state
	session, err := state.session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { state.dispatch(state.revoke); state.cleanup.Wait() })
	return actor, ctx, session.Epoch
}

func TestNativeFilesRejectUnreadyForeignAndStaleSessions(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	actor.ready = false
	if _, err := s.session(ctx); err == nil {
		t.Fatal("unready accepted")
	}
	if _, err := s.chooseDirectory(ctx, epoch); err == nil {
		t.Fatal("unready picker accepted")
	}
	actor.ready = true
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := s.session(foreign); err == nil {
		t.Fatal("foreign page accepted")
	}
	if _, err := s.chooseDirectory(ctx, epoch+1); !errors.Is(err, errFilesOwner) {
		t.Fatal("stale epoch accepted")
	}
	if err := s.teardown(ctx, epoch); err != nil {
		t.Fatal(err)
	}
	if err := s.teardown(ctx, epoch); err != nil {
		t.Fatal("teardown not idempotent")
	}
	current, err := s.session(ctx)
	if err != nil || current.Epoch == epoch {
		t.Fatal("epoch not renewed")
	}
	if err := s.teardown(ctx, epoch); err == nil {
		t.Fatal("old teardown accepted against new owner")
	}
	if _, err := s.chooseDirectory(ctx, epoch); err == nil {
		t.Fatal("old epoch accepted after remount")
	}
}

func TestNativeFilesCancellationErrorsParentAndBusy(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	for _, action := range []string{"directory", "import", "export"} {
		t.Run(action, func(t *testing.T) {
			var status string
			var err error
			switch action {
			case "directory":
				var r DirectorySelection
				r, err = s.chooseDirectory(ctx, epoch)
				status = string(r.Status)
			case "import":
				var r SettingsImportResult
				r, err = s.importSettings(ctx, epoch)
				status = string(r.Status)
			case "export":
				var r SettingsExportResult
				r, err = s.exportSettings(ctx, epoch, validRendererSettings())
				status = string(r.Status)
			}
			if err != nil || status != "cancelled" {
				t.Fatalf("cancel = %q, %v", status, err)
			}
		})
	}
	opened := make(chan struct{})
	release := make(chan struct{})
	s.picker = fakeFilePicker{open: func(options mygo.OpenDialogOptions) ([]string, error) {
		if options.Parent != actor.parent || !options.Directory || options.Multiple {
			t.Error("wrong picker parent/options")
		}
		if !actor.mu.TryLock() {
			t.Error("picker waiting inside main actor")
		} else {
			actor.mu.Unlock()
		}
		close(opened)
		<-release
		return nil, errors.New("synthetic picker error with private path")
	}}
	done := make(chan error, 1)
	go func() { _, err := s.chooseDirectory(ctx, epoch); done <- err }()
	<-opened
	if _, err := s.importSettings(ctx, epoch); !errors.Is(err, errFilesBusy) {
		t.Error("parallel panel not rejected")
	}
	close(release)
	if err := <-done; !errors.Is(err, errFilesPicker) || strings.Contains(err.Error(), "private") {
		t.Fatal("picker error not sanitized")
	}
}

func TestNativeFilesLatePanelKeepsBusyAndCannotAffectNewOwner(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	opened := make(chan struct{})
	release := make(chan struct{})
	selected := t.TempDir()
	s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) {
		close(opened)
		<-release
		return []string{selected}, nil
	}}
	done := make(chan error, 1)
	go func() { _, err := s.chooseDirectory(ctx, epoch); done <- err }()
	<-opened
	newCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.dispatch(func() { s.revoke(); actor.owner = newCtx })
	session, err := s.session(newCtx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.chooseDirectory(newCtx, session.Epoch); !errors.Is(err, errFilesBusy) {
		t.Error("old live panel allowed replacement panel")
	}
	close(release)
	if err := <-done; !errors.Is(err, errFilesOwner) {
		t.Fatal("late selection accepted")
	}
	if len(s.grants) != 0 {
		t.Fatal("late selection granted access")
	}
	s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { return []string{selected}, nil }}
	result, err := s.chooseDirectory(newCtx, session.Epoch)
	if err != nil || result.Grant == nil {
		t.Fatalf("new owner failed: %v", err)
	}
	s.finish(&fileOperation{owner: ctx, epoch: epoch})
	if len(s.grants) != 1 {
		t.Fatal("old completion removed new grant")
	}
	if err := s.teardown(ctx, epoch); err == nil {
		t.Fatal("old teardown allowed")
	}
	if len(s.grants) != 1 {
		t.Fatal("old teardown removed new grant")
	}
}

func TestNativeFilesGrantRelationsRevokeAndDefaultsAreNotAuthority(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	dir := t.TempDir()
	music := filepath.Join(dir, "music")
	child := filepath.Join(music, "child")
	other := filepath.Join(dir, "music-other")
	makeFileTestDirectory(t, child)
	makeFileTestDirectory(t, other)
	selected := music
	s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { return []string{selected}, nil }}
	result, err := s.chooseDirectory(ctx, epoch)
	if err != nil || result.Grant == nil || len(result.Grant.Token) != 64 {
		t.Fatalf("grant failed: %v", err)
	}
	token := result.Grant.Token
	entry := s.grants[token]
	for _, test := range []struct{ path, relation string }{{music, "duplicate"}, {child, "child"}, {dir, "parent"}} {
		selected = test.path
		overlap, err := s.chooseDirectory(ctx, epoch)
		if err != nil || overlap.Status != "overlap" || string(overlap.Relation) != test.relation || overlap.ExistingToken != token || overlap.Grant != nil {
			t.Fatal("incorrect overlap")
		}
	}
	selected = other
	if result, err := s.chooseDirectory(ctx, epoch); err != nil || result.Status != "selected" {
		t.Fatal("same prefix treated as child")
	}
	before := len(s.grants)
	for _, kind := range []DefaultDirectoryKind{DefaultDirectoryMusic, DefaultDirectoryDownloads} {
		result, err := s.defaultDirectory(ctx, epoch, kind)
		if err != nil || result.Authorized || result.DisplayPath == "" {
			t.Fatal("default directory query failed")
		}
	}
	if len(s.grants) != before {
		t.Fatal("query granted default directory")
	}
	if _, err := s.defaultDirectory(ctx, epoch, "home"); err == nil {
		t.Fatal("unbounded default kind accepted")
	}
	if err := s.revokeDirectory(ctx, epoch, "../../escape"); !errors.Is(err, errFilesToken) {
		t.Fatal("invalid token accepted")
	}
	for i := 0; i < 2; i++ {
		if err := s.revokeDirectory(ctx, epoch, token); err != nil {
			t.Fatal(err)
		}
	}
	s.cleanup.Wait()
	if _, err := entry.handle.root.Stat("."); !errors.Is(err, os.ErrClosed) {
		t.Fatal("revocation leaked root")
	}
	handles := make([]*directoryHandle, 0, len(s.grants))
	for _, entry := range s.grants {
		handles = append(handles, entry.handle)
	}
	s.dispatch(s.revoke)
	s.cleanup.Wait()
	for _, handle := range handles {
		if _, err := handle.root.Stat("."); !errors.Is(err, os.ErrClosed) {
			t.Fatal("owner revoke leaked root")
		}
	}
}

func TestNativeFilesSettingsPickerTransportAndInvalidInput(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	data, err := encodeRendererSettings(validRendererSettings())
	if err != nil {
		t.Fatal(err)
	}
	writeFileTestSettings(t, path, data)
	openCalls, saveCalls := 0, 0
	s.picker = fakeFilePicker{
		open: func(options mygo.OpenDialogOptions) ([]string, error) {
			openCalls++
			if options.Parent != actor.parent || options.Directory || options.Multiple || len(options.Filters) != 1 {
				t.Error("invalid import options")
			}
			return []string{path}, nil
		},
		save: func(options mygo.SaveDialogOptions) (string, error) {
			saveCalls++
			if options.Parent != actor.parent || len(options.Filters) != 1 {
				t.Error("invalid export options")
			}
			return path, nil
		},
	}
	invalid := validRendererSettings()
	invalid.SettingStore = `{"constructor":{}}`
	if _, err := s.exportSettings(ctx, epoch, invalid); err == nil || saveCalls != 0 {
		t.Fatal("invalid input opened save panel")
	}
	imported, err := s.importSettings(ctx, epoch)
	if err != nil || imported.Document == nil || imported.Document.Renderer != validRendererSettings() || openCalls != 1 {
		t.Fatalf("import failed: %v", err)
	}
	exported, err := s.exportSettings(ctx, epoch, validRendererSettings())
	if err != nil || exported.Status != "saved" || saveCalls != 1 {
		t.Fatalf("export failed: %v", err)
	}
	if len(s.grants) != 0 {
		t.Fatal("settings picker granted parent directory")
	}
	assertNoSettingsTemp(t, dir)
}

func TestNativeFilesCommitClaimOrdersRevocationWithoutBlockingMain(t *testing.T) {
	for _, commitFirst := range []bool{false, true} {
		name := "revoke-first"
		if commitFirst {
			name = "claim-first"
		}
		t.Run(name, func(t *testing.T) {
			actor, ctx, epoch := newFileTestActor(t)
			s := actor.state
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			original := []byte(`{"old":true}`)
			replacement := []byte(`{"new":true}`)
			writeFileTestSettings(t, path, original)
			op, err := s.begin(ctx, epoch)
			if err != nil {
				t.Fatal(err)
			}
			prepared := make(chan struct{})
			proceed := make(chan struct{})
			done := make(chan error, 1)
			exited := make(chan struct{})
			go func() {
				defer close(exited)
				defer s.finish(op)
				save, err := prepareSettingsSave(path, replacement)
				if err != nil {
					done <- err
					return
				}
				defer save.cleanup()
				if commitFirst {
					err = s.claimCommit(op)
				}
				close(prepared)
				<-proceed
				if !commitFirst {
					err = s.claimCommit(op)
				}
				if err == nil {
					err = save.replace()
				}
				done <- err
			}()
			<-prepared
			// IO is held at a barrier after claim. Revoke must finish without waiting for
			// that worker; the prepared parent belongs to the operation, not the grants.
			s.dispatch(s.revoke)
			newer, err := s.session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.begin(ctx, newer.Epoch); !errors.Is(err, errFilesBusy) {
				t.Fatal("pending IO lost Busy")
			}
			close(proceed)
			err = <-done
			<-exited
			actual, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if commitFirst {
				if err != nil || string(actual) != string(replacement) {
					t.Fatalf("authorized commit failed: %v", err)
				}
			} else if !errors.Is(err, errFilesOwner) || string(actual) != string(original) {
				t.Fatal("revocation did not prevent write")
			}
			assertNoSettingsTemp(t, dir)
		})
	}
}
