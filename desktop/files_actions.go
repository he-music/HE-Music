package main

import (
	"context"
	"os"
	"path"
	"path/filepath"

	"github.com/egoist/mygo"
)

// FileActionResult carries no machine paths. Removed remains true after a
// successful unlink even if the owner is revoked before the response.
type FileActionResult struct {
	Code    string `json:"code"`
	Removed bool   `json:"removed"`
}

// The SDK returns no reveal status; ok means the request was dispatched.
// Tests replace this backend and never open a real file manager.
var fileActionReveal = mygo.Shell.ShowItemInFolder

func (f *NativeFiles) RevealLocalFile(ctx context.Context, epoch uint64, ref LocalFileRef) FileActionResult {
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer lease.Release()
	info, err := f.localFileActionInfo(lease, ref)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	unlock, err := metadataCoordinatorFor(&f.state).lock(lease.Context(), info)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer unlock()
	if _, err = f.localFileActionInfo(lease, ref); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	// Shell needs an absolute path rather than a Root. Reject a moved grant or
	// substituted route instead of revealing an unrelated file at its old path.
	name := filepath.Join(lease.handle.canonical, filepath.FromSlash(ref.RelativePath))
	rootInfo, rootErr := os.Stat(lease.handle.canonical)
	current, currentErr := os.Lstat(name)
	if rootErr != nil || currentErr != nil || !os.SameFile(rootInfo, lease.handle.info) || !sameLocalFileInfo(info, current) {
		return FileActionResult{Code: "conflict"}
	}
	err = f.state.main(lease.owner, func(parent *mygo.Window) error {
		if err := f.state.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		fileActionReveal(name)
		return nil
	})
	return FileActionResult{Code: metadataCode(err)}
}

func (f *NativeFiles) localFileActionInfo(lease *directoryLease, ref LocalFileRef) (os.FileInfo, error) {
	file, err := f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.Stat()
}

// RemoveLocalFile permanently removes only the requested original directory
// entry. The menu owns user confirmation and the current-playing prohibition.
func (f *NativeFiles) RemoveLocalFile(ctx context.Context, epoch uint64, ref LocalFileRef) FileActionResult {
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer lease.Release()
	info, err := f.localFileActionInfo(lease, ref)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	unlock, err := metadataCoordinatorFor(&f.state).lock(lease.Context(), info)
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer unlock()
	if _, err = f.localFileActionInfo(lease, ref); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	parent, err := lease.handle.root.OpenRoot(path.Dir(ref.RelativePath))
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer parent.Close()
	pinned, err := parent.Stat(".")
	if err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	if metadataAudioDrain != nil {
		release, err := metadataAudioDrain(lease.Context(), f, info)
		if release != nil {
			defer release()
		}
		if err != nil {
			return FileActionResult{Code: metadataCode(err)}
		}
		if release == nil {
			return FileActionResult{Code: "readers_unavailable"}
		}
	} else {
		localAudioServers.Lock()
		if localAudioServers.servers[&f.state] != nil {
			localAudioServers.Unlock()
			return FileActionResult{Code: "readers_unavailable"}
		}
		// Exclude creation of the first server until ref cleanup completes.
		defer localAudioServers.Unlock()
	}
	// Re-resolve after waiting for actual reader closure, then verify both the
	// pinned parent and leaf immediately before the actor grants the commit.
	if _, err = f.localFileActionInfo(lease, ref); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	if err = fileActionCheckPinnedParent(lease, ref, parent, pinned, info); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	commit := newFileCommit()
	stop := context.AfterFunc(lease.Context(), func() { f.state.invalidateFileCommit(commit) })
	defer stop()
	if err = f.state.claimFileCommit(lease, commit); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	defer f.state.finishFileCommit(commit)
	// A claim has its own Root hold. Revocation can no longer undo it, but a
	// filesystem substitution still aborts. Like metadata commits this is not a
	// filesystem compare-and-swap against external writers.
	if err = fileActionCheckPinnedParent(lease, ref, parent, pinned, info); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	if err = parent.Remove(path.Base(ref.RelativePath)); err != nil {
		return FileActionResult{Code: metadataCode(err)}
	}
	invalidateLibraryMetadata(lease.handle.canonical, ref.RelativePath)
	// Cleanup is actor-owned but independent of the old owner. Invalidate every
	// registered identity alias while the audio gate and identity lock are held;
	// hardlink directory entries themselves remain untouched.
	f.state.dispatch(func() {
		for id, entry := range f.state.fileEntries {
			if os.SameFile(entry.info, info) {
				delete(f.state.fileEntries, id)
				delete(entry.handle.filePaths, entry.ref.RelativePath)
				invalidateLibraryMetadata(entry.handle.canonical, entry.ref.RelativePath)
			}
		}
	})
	return FileActionResult{Code: metadataCode(f.state.checkLease(lease)), Removed: true}
}

func fileActionCheckPinnedParent(lease *directoryLease, ref LocalFileRef, parent *os.Root, pinned, original os.FileInfo) error {
	route, err := lease.handle.root.Stat(path.Dir(ref.RelativePath))
	if err != nil || !os.SameFile(route, pinned) {
		return errFilesChanged
	}
	current, err := parent.Lstat(path.Base(ref.RelativePath))
	if err != nil || !current.Mode().IsRegular() || !sameLocalFileInfo(original, current) {
		return errFilesChanged
	}
	return nil
}
