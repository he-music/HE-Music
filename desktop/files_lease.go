package main

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/egoist/mygo"
)

var (
	errFilesLease   = errors.New("directory lease is no longer active")
	errFilesPath    = errors.New("invalid local file path")
	errFilesChanged = errors.New("local file changed")
)

// LocalFileRef is an opaque, session-scoped reference to a regular file below a
// granted directory. RelativePath is descriptive; authorization remains the
// grant, lease, and backend entry identity.
type LocalFileRef struct {
	GrantToken   string `json:"grantToken"`
	RelativePath string `json:"relativePath"`
	FileID       string `json:"fileId"`
	Version      string `json:"version"`
}

type directoryLease struct {
	state     *nativeFilesState
	owner     context.Context
	epoch     uint64
	parent    *mygo.Window
	token     string
	handle    *directoryHandle
	context   context.Context
	cancel    context.CancelFunc
	released  atomic.Bool
	stopGrant func() bool
}

type localFileEntry struct {
	ref    LocalFileRef
	handle *directoryHandle
	info   os.FileInfo
	parent os.FileInfo
}

type fileCommit struct {
	phase  atomic.Uint32
	mu     sync.Mutex
	handle *directoryHandle
	state  *nativeFilesState
}

const (
	fileCommitActive uint32 = iota
	fileCommitInvalid
	fileCommitClaimed
	fileCommitFinished
)

func newFileCommit() *fileCommit {
	return &fileCommit{}
}

func (s *nativeFilesState) acquireDirectory(ctx context.Context, epoch uint64, token string) (*directoryLease, error) {
	var lease *directoryLease
	err := s.main(ctx, func(parent *mygo.Window) error {
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		if decoded, err := decodeDirectoryToken(token); err != nil || len(decoded) != 32 {
			return errFilesToken
		}
		entry, ok := s.grants[token]
		if !ok || entry.handle == nil || entry.handle.retired.Load() {
			return errFilesToken
		}
		if entry.grant.Epoch != epoch || entry.handle.root == nil {
			return errFilesOwner
		}
		if entry.handle.leaseContext == nil {
			entry.handle.leaseContext, entry.handle.leaseCancel = context.WithCancel(context.Background())
		}
		if !entry.handle.retainLease() {
			return errFilesLease
		}
		leaseContext, cancel := context.WithCancel(ctx)
		stopGrant := context.AfterFunc(entry.handle.leaseContext, cancel)
		lease = &directoryLease{
			state:     s,
			owner:     ctx,
			epoch:     epoch,
			parent:    parent,
			token:     token,
			handle:    entry.handle,
			context:   leaseContext,
			cancel:    cancel,
			stopGrant: stopGrant,
		}
		return nil
	})
	return lease, err
}

func (l *directoryLease) Context() context.Context {
	if l == nil || l.context == nil {
		return context.Background()
	}
	return l.context
}

func (l *directoryLease) Release() {
	if l == nil || !l.released.CompareAndSwap(false, true) {
		return
	}
	l.cancel()
	l.stopGrant()
	l.handle.releaseReference(l.state)
}

func (s *nativeFilesState) checkLease(lease *directoryLease) error {
	if lease == nil || lease.state != s || lease.released.Load() || lease.owner.Err() != nil {
		return errFilesLease
	}
	return s.main(lease.owner, func(parent *mygo.Window) error {
		return s.checkLeaseOnMain(lease, parent)
	})
}

// checkLeaseOnMain runs only on the state actor, including the commit claim.
func (s *nativeFilesState) checkLeaseOnMain(lease *directoryLease, parent *mygo.Window) error {
	if lease == nil || lease.state != s || lease.released.Load() || lease.Context().Err() != nil || lease.handle == nil || lease.handle.retired.Load() {
		return errFilesLease
	}
	if parent != lease.parent || !s.owns(lease.owner, lease.epoch) {
		return errFilesOwner
	}
	entry, ok := s.grants[lease.token]
	if !ok || entry.handle != lease.handle || entry.grant.Epoch != lease.epoch {
		return errFilesLease
	}
	return nil
}

func (s *nativeFilesState) claimFileCommit(lease *directoryLease, commit *fileCommit) error {
	if lease == nil || commit == nil {
		return errFilesLease
	}
	return s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		commit.mu.Lock()
		defer commit.mu.Unlock()
		if commit.phase.Load() != fileCommitActive {
			return errFilesBusy
		}
		if !lease.handle.retainLease() {
			return errFilesLease
		}
		// A claimed commit owns a separate Root reference until finish. Neither
		// owner cancellation nor the caller releasing its lease can drop it.
		commit.handle, commit.state = lease.handle, s
		commit.phase.Store(fileCommitClaimed)
		return nil
	})
}

func (s *nativeFilesState) invalidateFileCommit(commit *fileCommit) {
	if commit != nil {
		commit.mu.Lock()
		defer commit.mu.Unlock()
		commit.phase.CompareAndSwap(fileCommitActive, fileCommitInvalid)
	}
}

func (s *nativeFilesState) finishFileCommit(commit *fileCommit) {
	if commit == nil {
		return
	}
	commit.mu.Lock()
	if commit.state != s || !commit.phase.CompareAndSwap(fileCommitClaimed, fileCommitFinished) {
		commit.mu.Unlock()
		return
	}
	handle := commit.handle
	commit.mu.Unlock()
	handle.releaseReference(s)
}

func validateLocalRelativePath(path string) error {
	if path == "" || strings.ContainsAny(path, "\\\x00:") || strings.Contains(path, "//") {
		return errFilesPath
	}
	if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") || filepathVolumeName(path) != "" {
		return errFilesPath
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return errFilesPath
		}
	}
	return nil
}

// filepathVolumeName is isolated so the transport validation stays explicit on
// every platform; colon is rejected above even where filepath.VolumeName is empty.
func filepathVolumeName(path string) string {
	return filepath.VolumeName(path)
}

func (s *nativeFilesState) registerLocalFile(lease *directoryLease, relativePath string) (*LocalFileRef, *os.File, error) {
	if err := validateLocalRelativePath(relativePath); err != nil {
		return nil, nil, err
	}
	if err := s.checkLease(lease); err != nil {
		return nil, nil, err
	}
	file, info, parentInfo, err := openGrantedRegularInfo(lease, relativePath)
	if err != nil {
		return nil, nil, err
	}
	fileID, err := newDirectoryToken()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	version, err := newDirectoryToken()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	ref := &LocalFileRef{GrantToken: lease.token, RelativePath: relativePath, FileID: fileID, Version: version}
	err = s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		if fileID := lease.handle.filePaths[relativePath]; fileID != "" {
			if existing := s.fileEntries[fileID]; existing != nil {
				if sameLocalFileInfo(existing.info, info) && os.SameFile(existing.parent, parentInfo) {
					*ref = existing.ref
					return nil
				}
				delete(s.fileEntries, fileID)
			}
		}
		if len(s.fileEntries) >= 65536 {
			return errFilesBusy
		}
		if s.fileEntries == nil {
			s.fileEntries = make(map[string]*localFileEntry)
		}
		s.fileEntries[fileID] = &localFileEntry{ref: *ref, handle: lease.handle, info: info, parent: parentInfo}
		if lease.handle.filePaths == nil {
			lease.handle.filePaths = make(map[string]string)
		}
		lease.handle.filePaths[relativePath] = fileID
		return nil
	})
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return ref, file, nil
}

func (s *nativeFilesState) resolveLocalFile(lease *directoryLease, ref LocalFileRef) (*os.File, error) {
	if err := validateLocalRelativePath(ref.RelativePath); err != nil {
		return nil, err
	}
	if err := s.checkLease(lease); err != nil {
		return nil, err
	}
	var entry *localFileEntry
	err := s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		candidate, ok := s.fileEntries[ref.FileID]
		if !ok || candidate.handle != lease.handle || candidate.ref != ref {
			return errFilesChanged
		}
		entry = candidate
		return nil
	})
	if err != nil {
		return nil, err
	}
	file, info, parentInfo, err := openGrantedRegularInfo(lease, ref.RelativePath)
	if err != nil {
		return nil, err
	}
	if !sameLocalFileInfo(entry.info, info) || !os.SameFile(entry.parent, parentInfo) {
		file.Close()
		return nil, errFilesChanged
	}
	if err := s.checkLease(lease); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

// Callers keep the lease until all returned files are closed. Cancellation asks
// the consumer to stop; it never releases a Root while a worker still uses it.
func openGrantedRegular(lease *directoryLease, relativePath string) (*os.File, os.FileInfo, error) {
	file, info, _, err := openGrantedRegularInfo(lease, relativePath)
	return file, info, err
}

func openGrantedRegularInfo(lease *directoryLease, relativePath string) (*os.File, os.FileInfo, os.FileInfo, error) {
	if err := validateLocalRelativePath(relativePath); err != nil {
		return nil, nil, nil, err
	}
	if lease == nil || lease.released.Load() || lease.Context().Err() != nil || lease.handle == nil || lease.handle.root == nil || lease.handle.retired.Load() {
		return nil, nil, nil, errFilesLease
	}
	parent := lease.handle.root
	var pinned []*os.Root
	defer func() {
		for _, root := range pinned {
			_ = root.Close()
		}
	}()
	type ancestor struct {
		path string
		info os.FileInfo
	}
	var ancestors []ancestor
	parts := strings.Split(relativePath, "/")
	for index, part := range parts[:len(parts)-1] {
		before, err := parent.Lstat(part)
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			return nil, nil, nil, errFilesPath
		}
		next, err := parent.OpenRoot(part)
		if err != nil {
			return nil, nil, nil, errFilesPath
		}
		pinned = append(pinned, next)
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			return nil, nil, nil, errFilesChanged
		}
		ancestors = append(ancestors, ancestor{path: strings.Join(parts[:index+1], "/"), info: after})
		parent = next
	}
	parentInfo, err := parent.Stat(".")
	if err != nil {
		return nil, nil, nil, errFilesChanged
	}
	name := parts[len(parts)-1]
	before, err := parent.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, nil, nil, errFilesPath
	}
	file, err := parent.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, nil, errFilesPath
	}
	reject := func(err error) (*os.File, os.FileInfo, os.FileInfo, error) {
		_ = file.Close()
		return nil, nil, nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !sameLocalFileInfo(before, after) {
		return reject(errFilesChanged)
	}
	// Recheck the route from the granted Root to each pinned ancestor and leaf.
	// This detects substitutions around open; it cannot exclude external changes
	// after this check and makes no filesystem-wide compare-and-swap promise.
	for _, item := range ancestors {
		current, err := lease.handle.root.Lstat(item.path)
		if err != nil || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(current, item.info) {
			return reject(errFilesChanged)
		}
	}
	current, err := lease.handle.root.Lstat(relativePath)
	if err != nil || !current.Mode().IsRegular() || !sameLocalFileInfo(current, after) {
		return reject(errFilesChanged)
	}
	if lease.released.Load() || lease.Context().Err() != nil || lease.handle.retired.Load() {
		return reject(errFilesLease)
	}
	return file, after, parentInfo, nil
}

func sameLocalFileInfo(left, right os.FileInfo) bool {
	return os.SameFile(left, right) && left.Size() == right.Size() && left.Mode() == right.Mode() && left.ModTime().Equal(right.ModTime())
}

func decodeDirectoryToken(token string) ([]byte, error) {
	return hex.DecodeString(token)
}

func (s *nativeFilesState) dropFileEntries(handle *directoryHandle) {
	if s.fileEntries == nil || handle == nil {
		return
	}
	handle.filePaths = nil
	for fileID, entry := range s.fileEntries {
		if entry.handle == handle {
			delete(s.fileEntries, fileID)
		}
	}
}

func (h *directoryHandle) retainLease() bool {
	if h.retired.Load() {
		return false
	}
	h.leaseCount.Add(1)
	if h.retired.Load() {
		h.leaseCount.Add(-1)
		return false
	}
	return true
}

func (h *directoryHandle) releaseLease() int64 { return h.leaseCount.Add(-1) }

func (h *directoryHandle) releaseReference(s *nativeFilesState) {
	if h.releaseLease() == 0 && h.retired.Load() {
		h.closeWhenIdle(s)
	}
}

func (h *directoryHandle) retire(s *nativeFilesState) {
	if !h.retired.CompareAndSwap(false, true) {
		return
	}
	if h.leaseCancel != nil {
		h.leaseCancel()
	}
	if h.leaseCount.Load() == 0 {
		h.closeWhenIdle(s)
	}
}

func (h *directoryHandle) closeWhenIdle(s *nativeFilesState) {
	if h.leaseCount.Load() != 0 || !h.closed.CompareAndSwap(false, true) {
		return
	}
	s.cleanup.Add(1)
	go func() {
		defer s.cleanup.Done()
		_ = h.root.Close()
	}()
}
