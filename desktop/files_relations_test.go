package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func TestDirectoryIdentityRelationsDoNotDependOnPathSpelling(t *testing.T) {
	base := t.TempDir()
	childPath := filepath.Join(base, "Music", "child")
	makeFileTestDirectory(t, childPath)
	parent, err := openDirectoryHandle(filepath.Dir(childPath))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.root.Close()
	child, err := openDirectoryHandle(childPath)
	if err != nil {
		t.Fatal(err)
	}
	defer child.root.Close()
	// Deliberately change only display spelling after capturing real file identity.
	// This does not pretend the test volume itself is case insensitive.
	child.canonical = strings.ToUpper(child.canonical)
	if got := directoryIdentityRelation(parent, child); got != DirectoryChild {
		t.Fatal("relationship depended on spelling")
	}
	if got := directoryIdentityRelation(child, parent); got != DirectoryParent {
		t.Fatal("parent relationship depended on spelling")
	}
}

func TestNativeFilesRevokedSnapshotGrantDoesNotBlockNewSelection(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	s := actor.state
	parentPath := t.TempDir()
	childPath := filepath.Join(parentPath, "child")
	makeFileTestDirectory(t, childPath)
	selected := parentPath
	s.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { return []string{selected}, nil }}
	existing, err := s.chooseDirectory(ctx, epoch)
	if err != nil || existing.Grant == nil {
		t.Fatal("initial grant failed")
	}
	token := existing.Grant.Token
	selected = childPath
	originalMain := s.main
	calls := 0
	s.main = func(caller context.Context, fn func(*mygo.Window) error) error {
		err := originalMain(caller, fn)
		calls++
		// begin, post-picker check, then relationship snapshot: revoke immediately
		// after that snapshot, before final publication. Policy/IO stay production.
		if calls == 3 {
			revokeErr := originalMain(ctx, func(*mygo.Window) error {
				entry := s.grants[token]
				delete(s.grants, token)
				s.closeDirectories([]*directoryHandle{entry.handle})
				return nil
			})
			if revokeErr != nil {
				t.Error(revokeErr)
			}
		}
		return err
	}
	result, err := s.chooseDirectory(ctx, epoch)
	if err != nil || result.Status != DirectorySelected || result.Grant == nil {
		t.Fatalf("revoked snapshot incorrectly blocked selection: %v", err)
	}
	s.cleanup.Wait()
}
