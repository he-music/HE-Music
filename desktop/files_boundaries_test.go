package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func TestNativeFilesLateImportChecksOwnerBeforeReading(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	opened := make(chan struct{})
	release := make(chan struct{})
	dir := t.TempDir()
	path := filepath.Join(dir, "not-read.json")
	// If import reached IO it would return a document/IO error, not errFilesOwner.
	writeFileTestSettings(t, path, []byte(`invalid synthetic document`))
	s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { close(opened); <-release; return []string{path}, nil }}
	done := make(chan error, 1)
	go func() {
		result, err := s.importSettings(ctx, epoch)
		if result.Document != nil {
			t.Error("late import returned document")
		}
		done <- err
	}()
	<-opened
	s.dispatch(s.revoke)
	close(release)
	if err := <-done; !errors.Is(err, errFilesOwner) {
		t.Fatal("late import did not reject before IO")
	}
}

func TestNativeFilesCancelledContextAndChangedParentRejectPanelResults(t *testing.T) {
	for _, change := range []string{"context", "parent"} {
		t.Run(change, func(t *testing.T) {
			actor, _, _ := newFileTestActor(t)
			s := actor.state
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.dispatch(func() { s.revoke(); actor.owner = ctx })
			session, err := s.session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			opened := make(chan struct{})
			release := make(chan struct{})
			selected := t.TempDir()
			s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) {
				close(opened)
				<-release
				return []string{selected}, nil
			}}
			done := make(chan error, 1)
			go func() { _, err := s.chooseDirectory(ctx, session.Epoch); done <- err }()
			<-opened
			if change == "context" {
				cancel()
			} else {
				s.dispatch(func() { actor.parent = &mygo.Window{} })
			}
			close(release)
			if err := <-done; !errors.Is(err, errFilesOwner) {
				t.Fatal("invalidated panel granted result")
			}
			if len(s.grants) != 0 {
				t.Fatal("invalid owner retained grant")
			}
		})
	}
}

func TestNativeFilesActualExportRevocationBeforeAndAfterClaim(t *testing.T) {
	for _, claimFirst := range []bool{false, true} {
		name := "revoke-before-claim"
		if claimFirst {
			name = "revoke-after-claim"
		}
		t.Run(name, func(t *testing.T) {
			actor, ctx, epoch := newFileTestActor(t)
			s := actor.state
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			original := []byte(`{"original":true}`)
			writeFileTestSettings(t, path, original)
			s.picker = fakeFilePicker{save: func(mygo.SaveDialogOptions) (string, error) { return path, nil }}
			// Fake main dispatcher provides a barrier at the actual production commit
			// call. Detect prepared temp state, without replacing the policy or IO code.
			originalMain := s.main
			atCommit := make(chan struct{})
			proceed := make(chan struct{})
			intercepted := false
			s.main = func(caller context.Context, fn func(*mygo.Window) error) error {
				entries, err := os.ReadDir(dir)
				if err != nil {
					return errFileIO
				}
				hasTemp := false
				for _, entry := range entries {
					if strings.HasPrefix(entry.Name(), ".he-music-settings-") {
						hasTemp = true
					}
				}
				if !intercepted && hasTemp {
					intercepted = true
					if claimFirst {
						err := originalMain(caller, fn)
						if err != nil {
							return err
						}
						close(atCommit)
						<-proceed
						return nil
					}
					close(atCommit)
					<-proceed
				}
				return originalMain(caller, fn)
			}
			done := make(chan error, 1)
			go func() {
				result, err := s.exportSettings(ctx, epoch, validRendererSettings())
				if result.Status == "saved" {
					t.Error("stale owner received success")
				}
				done <- err
			}()
			<-atCommit
			s.dispatch(s.revoke)
			// Revoke cannot wait for panel/IO or close the operation's prepared root.
			if _, err := s.session(ctx); err != nil {
				t.Fatal(err)
			}
			close(proceed)
			if err := <-done; !errors.Is(err, errFilesOwner) {
				t.Fatal("stale export result not rejected")
			}
			actual, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if claimFirst {
				if _, err := decodeRendererSettings(actual); err != nil {
					t.Fatal("claimed commit did not complete")
				}
			} else if string(actual) != string(original) {
				t.Fatal("revoked unclaimed operation changed original")
			}
			assertNoSettingsTemp(t, dir)
		})
	}
}
