package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func fileActionFixture(t *testing.T) (*NativeFiles, context.Context, uint64, LocalFileRef, string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("temporary file action fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, ctx, epoch, ref := metadataTestService(t, dir)
	reveal := fileActionReveal
	fileActionReveal = func(string) { t.Error("unexpected native reveal request") }
	t.Cleanup(func() { fileActionReveal = reveal })
	return f, ctx, epoch, ref, dir
}

func fileActionAwait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("file action did not reach expected boundary")
	}
}

func fileActionResult(t *testing.T, done <-chan FileActionResult) FileActionResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("file action did not return")
		return FileActionResult{}
	}
}

func TestFileActionsRevealUsesAuthorizedBackendPath(t *testing.T) {
	f, ctx, epoch, ref, dir := fileActionFixture(t)
	original := fileActionReveal
	t.Cleanup(func() { fileActionReveal = original })
	var revealed []string
	fileActionReveal = func(name string) { revealed = append(revealed, name) }
	result := f.RevealLocalFile(ctx, epoch, ref)
	if result.Code != "ok" || result.Removed || len(revealed) != 1 || revealed[0] != filepath.Join(dir, "song.mp3") {
		t.Fatalf("unexpected reveal: %+v %v", result, revealed)
	}
	encoded, err := json.Marshal(result)
	if err != nil || string(encoded) != `{"code":"ok","removed":false}` {
		t.Fatalf("unexpected transport: %s %v", encoded, err)
	}
	if _, err := os.Stat(revealed[0]); err != nil {
		t.Fatal("reveal modified the original", err)
	}
}

func TestFileActionsRejectUnauthorizedAndForgedReferences(t *testing.T) {
	f, ctx, epoch, ref, dir := fileActionFixture(t)
	original := fileActionReveal
	t.Cleanup(func() { fileActionReveal = original })
	fileActionReveal = func(string) { t.Error("unauthorized reveal reached the backend") }
	foreign := t.Context()
	for _, operation := range []struct {
		name string
		call func(context.Context, uint64, LocalFileRef) FileActionResult
	}{{"reveal", f.RevealLocalFile}, {"remove", f.RemoveLocalFile}} {
		t.Run(operation.name, func(t *testing.T) {
			for _, field := range []string{"owner", "epoch", "grant", "id", "version", "absolute", "traversal", "ads"} {
				forged, caller, generation := ref, ctx, epoch
				switch field {
				case "owner":
					caller = foreign
				case "epoch":
					generation++
				case "grant":
					forged.GrantToken = strings.Repeat("0", 64)
				case "id":
					forged.FileID = strings.Repeat("0", 64)
				case "version":
					forged.Version = strings.Repeat("0", 64)
				case "absolute":
					forged.RelativePath = filepath.Join(dir, "song.mp3")
				case "traversal":
					forged.RelativePath = "../song.mp3"
				case "ads":
					forged.RelativePath = "song.mp3:stream"
				}
				if result := operation.call(caller, generation, forged); result.Code == "ok" || result.Removed {
					t.Errorf("%s accepted: %+v", field, result)
				}
			}
		})
	}
	if _, err := os.Stat(filepath.Join(dir, "song.mp3")); err != nil {
		t.Fatal("rejected request removed the original", err)
	}
}

func TestFileActionsRejectReplacementAndMovedRevealPath(t *testing.T) {
	for _, kind := range []string{"leaf", "symlink", "grant"} {
		t.Run(kind, func(t *testing.T) {
			f, ctx, epoch, ref, dir := fileActionFixture(t)
			original := fileActionReveal
			t.Cleanup(func() { fileActionReveal = original })
			fileActionReveal = func(string) { t.Error("stale path reached reveal backend") }
			name := filepath.Join(dir, "song.mp3")
			if kind == "grant" {
				moved := dir + "-moved"
				if err := os.Rename(dir, moved); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Rename(moved, dir) })
			} else {
				if err := os.Rename(name, filepath.Join(dir, "old")); err != nil {
					t.Fatal(err)
				}
				var err error
				if kind == "symlink" {
					err = os.Symlink("old", name)
				} else {
					err = os.WriteFile(name, []byte("replacement"), 0o600)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			if result := f.RevealLocalFile(ctx, epoch, ref); result.Code == "ok" || result.Removed {
				t.Fatalf("stale reveal: %+v", result)
			}
			if kind != "grant" {
				if result := f.RemoveLocalFile(ctx, epoch, ref); result.Code == "ok" || result.Removed {
					t.Fatalf("stale removal: %+v", result)
				}
				if _, err := os.Lstat(name); err != nil {
					t.Fatal("removed replacement", err)
				}
			}
		})
	}
}

func TestFileActionsRemoveOnlyOriginalAndInvalidateAliases(t *testing.T) {
	f, ctx, epoch, ref, dir := fileActionFixture(t)
	for _, name := range []string{"song.lrc", "song.jpg", "other.mp3"} {
		requireTestNoError(t, os.WriteFile(filepath.Join(dir, name), []byte("preserve"), 0o600))
	}
	requireTestNoError(t, os.Link(filepath.Join(dir, "song.mp3"), filepath.Join(dir, "alias.mp3")))
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	requireTestNoError(t, err)
	defer lease.Release()
	alias, file, err := f.state.registerLocalFile(lease, "alias.mp3")
	if err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	other, file, err := f.state.registerLocalFile(lease, "other.mp3")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if err = prepareLibraryIndex(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		savedLibraryIndex.Lock()
		savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err = "", nil, nil
		savedLibraryIndex.Unlock()
	})
	for _, name := range []string{"song.mp3", "alias.mp3"} {
		rememberLibraryMetadata(dir, name, info, metadata.Info{Title: "cached fixture"})
	}
	if result := f.RemoveLocalFile(ctx, epoch, ref); result.Code != "ok" || !result.Removed {
		t.Fatalf("remove failed: %+v", result)
	}
	if _, err = os.Lstat(filepath.Join(dir, "song.mp3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("original still present: %v", err)
	}
	for _, name := range []string{"song.lrc", "song.jpg", "other.mp3", "alias.mp3"} {
		if _, err = os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("removed unrelated entry %s: %v", name, err)
		}
	}
	for _, old := range []LocalFileRef{ref, *alias} {
		if file, err := f.state.resolveLocalFile(lease, old); err == nil {
			file.Close()
			t.Fatal("old reference still valid")
		}
		if _, found := cachedLibraryMetadata(dir, old.RelativePath, info); found {
			t.Fatal("removed identity metadata still cached")
		}
	}
	if result := f.RemoveLocalFile(ctx, epoch, ref); result.Removed || result.Code == "ok" {
		t.Fatalf("replayed deletion: %+v", result)
	}
	file, err = f.state.resolveLocalFile(lease, *other)
	if err != nil {
		t.Fatal("unrelated reference invalidated", err)
	}
	file.Close()
	fresh, file, err := f.state.registerLocalFile(lease, "alias.mp3")
	if err != nil {
		t.Fatal("remaining hardlink cannot be registered", err)
	}
	file.Close()
	if *fresh == *alias {
		t.Fatal("alias reused invalidated capability")
	}
}

func TestFileActionsWaitForIdentityLockAndCancel(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "reveal", true: "remove"}[remove], func(t *testing.T) {
			f, ctx, epoch, ref, dir := fileActionFixture(t)
			info, err := os.Stat(filepath.Join(dir, "song.mp3"))
			if err != nil {
				t.Fatal(err)
			}
			unlock, err := metadataCoordinatorFor(&f.state).lock(ctx, info)
			if err != nil {
				t.Fatal(err)
			}
			defer unlock()
			entered := make(chan struct{})
			var once sync.Once
			calls := 0
			main := f.state.main
			f.state.main = func(c context.Context, fn func(*mygo.Window) error) error {
				err := main(c, fn)
				calls++
				// acquire plus resolve's check/lookup/final check have returned.
				if calls == 4 {
					once.Do(func() { close(entered) })
				}
				return err
			}
			done := make(chan FileActionResult, 1)
			go func() {
				if remove {
					done <- f.RemoveLocalFile(ctx, epoch, ref)
				} else {
					done <- f.RevealLocalFile(ctx, epoch, ref)
				}
			}()
			fileActionAwait(t, entered)
			select {
			case result := <-done:
				t.Fatalf("bypassed save identity lock: %+v", result)
			case <-time.After(25 * time.Millisecond):
			}
			f.state.dispatch(f.state.revoke)
			if result := fileActionResult(t, done); result.Code == "ok" || result.Removed {
				t.Fatalf("cancelled lock waiter committed: %+v", result)
			}
			if _, err = os.Stat(filepath.Join(dir, "song.mp3")); err != nil {
				t.Fatal("cancelled waiter removed file", err)
			}
		})
	}
}

func TestFileActionsRemoveRechecksAfterDrain(t *testing.T) {
	for _, kind := range []string{"revoke", "leaf", "parent", "drain_error"} {
		t.Run(kind, func(t *testing.T) {
			f, ctx, epoch, ref, dir := fileActionFixture(t)
			if kind == "parent" {
				if err := os.Mkdir(filepath.Join(dir, "album"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(dir, "song.mp3"), filepath.Join(dir, "album", "song.mp3")); err != nil {
					t.Fatal(err)
				}
				lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
				if err != nil {
					t.Fatal(err)
				}
				registered, file, err := f.state.registerLocalFile(lease, "album/song.mp3")
				if err != nil {
					lease.Release()
					t.Fatal(err)
				}
				file.Close()
				lease.Release()
				ref = *registered
			}
			original := beforeLocalFileMutation
			t.Cleanup(func() { beforeLocalFileMutation = original })
			released := false
			beforeLocalFileMutation = func(context.Context, *NativeFiles, os.FileInfo) (func(), error) {
				release := func() { released = true }
				switch kind {
				case "revoke":
					f.state.dispatch(f.state.revoke)
				case "leaf":
					if err := os.Rename(filepath.Join(dir, "song.mp3"), filepath.Join(dir, "old")); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("replacement"), 0o600); err != nil {
						t.Fatal(err)
					}
				case "parent":
					if err := os.Rename(filepath.Join(dir, "album"), filepath.Join(dir, "old-album")); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(filepath.Join(dir, "album"), 0o700); err != nil {
						t.Fatal(err)
					}
					if err := os.Link(filepath.Join(dir, "old-album", "song.mp3"), filepath.Join(dir, "album", "song.mp3")); err != nil {
						t.Fatal(err)
					}
				case "drain_error":
					return release, context.Canceled
				}
				return release, nil
			}
			if result := f.RemoveLocalFile(ctx, epoch, ref); result.Code == "ok" || result.Removed {
				t.Fatalf("committed after %s: %+v", kind, result)
			}
			if !released {
				t.Fatal("failed operation leaked audio gate")
			}
			if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(ref.RelativePath))); err != nil {
				t.Fatal("failure removed current entry", err)
			}
		})
	}
}

func TestFileActionsClaimSurvivesRevocationAndReportsRemoved(t *testing.T) {
	f, ctx, epoch, ref, dir := fileActionFixture(t)
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		t.Fatal(err)
	}
	handle := lease.handle
	lease.Release()
	main := f.state.main
	revoked := false
	f.state.main = func(c context.Context, fn func(*mygo.Window) error) error {
		err := main(c, fn)
		if err == nil && !revoked && handle.leaseCount.Load() == 2 {
			revoked = true
			f.state.dispatch(f.state.revoke)
			if _, err := handle.root.Stat("."); err != nil {
				t.Error("claim lost Root on revoke", err)
			}
		}
		return err
	}
	result := f.RemoveLocalFile(ctx, epoch, ref)
	if !revoked || result.Code != "revoked" || !result.Removed {
		t.Fatalf("claimed deletion reported inaccurately: %+v revoked=%v", result, revoked)
	}
	if _, err = os.Stat(filepath.Join(dir, "song.mp3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("claimed removal did not finish: %v", err)
	}
	f.state.cleanup.Wait()
	if handle.leaseCount.Load() != 0 {
		t.Fatal("claim or worker lease leaked")
	}
	if _, err = handle.root.Stat("."); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("retired Root not closed after worker finish: %v", err)
	}
}

func TestFileActionsClaimFailureReleasesHolds(t *testing.T) {
	f, ctx, epoch, ref, dir := fileActionFixture(t)
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		t.Fatal(err)
	}
	handle := lease.handle
	lease.Release()
	main := f.state.main
	substituted := false
	f.state.main = func(c context.Context, fn func(*mygo.Window) error) error {
		err := main(c, fn)
		if err == nil && !substituted && handle.leaseCount.Load() == 2 {
			substituted = true
			if err := os.Rename(filepath.Join(dir, "song.mp3"), filepath.Join(dir, "old")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("replacement"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return err
	}
	result := f.RemoveLocalFile(ctx, epoch, ref)
	if !substituted || result.Code != "conflict" || result.Removed {
		t.Fatalf("claimed replacement was removed: %+v substituted=%v", result, substituted)
	}
	if handle.leaseCount.Load() != 0 {
		t.Fatal("failed commit leaked Root hold")
	}
	data, err := os.ReadFile(filepath.Join(dir, "song.mp3"))
	if err != nil || string(data) != "replacement" {
		t.Fatalf("replacement modified: %q %v", data, err)
	}
}
