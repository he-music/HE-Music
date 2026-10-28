package main

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	state    *nativeFilesState
	owner    context.Context
	epoch    uint64
	parent   *mygo.Window
	token    string
	handle   *directoryHandle
	context  context.Context
	cancel   context.CancelFunc
	released atomic.Bool
}

type localFileEntry struct {
	ref    LocalFileRef
	handle *directoryHandle
	info   os.FileInfo
}

type fileCommit struct {
	phase atomic.Uint32
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
		leaseContext, cancel := context.WithCancel(entry.handle.leaseContext)
		lease = &directoryLease{
			state:   s,
			owner:   ctx,
			epoch:   epoch,
			parent:  parent,
			token:   token,
			handle:  entry.handle,
			context: leaseContext,
			cancel:  cancel,
		}
		context.AfterFunc(ctx, lease.Release)
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
	l.state.dispatch(func() {
		if l.handle.releaseLease() == 0 && l.handle.retired.Load() {
			l.handle.closeWhenIdle(l.state)
		}
	})
}

func (s *nativeFilesState) checkLease(lease *directoryLease) error {
	if lease == nil || lease.state != s || lease.released.Load() || lease.owner.Err() != nil {
		return errFilesLease
	}
	return s.main(lease.owner, func(parent *mygo.Window) error {
		if lease.released.Load() || lease.handle == nil || lease.handle.retired.Load() {
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
	})
}

func (s *nativeFilesState) claimFileCommit(lease *directoryLease, commit *fileCommit) error {
	if commit == nil || !commit.phase.CompareAndSwap(fileCommitActive, fileCommitClaimed) {
		return errFilesBusy
	}
	if err := s.checkLease(lease); err != nil {
		commit.phase.Store(fileCommitInvalid)
		return err
	}
	return nil
}

func (s *nativeFilesState) invalidateFileCommit(commit *fileCommit) {
	if commit != nil {
		commit.phase.CompareAndSwap(fileCommitActive, fileCommitInvalid)
	}
}

func (s *nativeFilesState) finishFileCommit(commit *fileCommit) {
	if commit != nil {
		commit.phase.CompareAndSwap(fileCommitClaimed, fileCommitFinished)
	}
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
	file, info, err := openGrantedRegular(lease, relativePath)
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
		if parent != lease.parent || lease.released.Load() || lease.handle.retired.Load() || !s.owns(lease.owner, lease.epoch) {
			return errFilesLease
		}
		if s.fileEntries == nil {
			s.fileEntries = make(map[string]*localFileEntry)
		}
		s.fileEntries[fileID] = &localFileEntry{ref: *ref, handle: lease.handle, info: info}
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
		if parent != lease.parent || lease.released.Load() || !s.owns(lease.owner, lease.epoch) {
			return errFilesOwner
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
	file, info, err := openGrantedRegular(lease, ref.RelativePath)
	if err != nil {
		return nil, err
	}
	if !sameLocalFileInfo(entry.info, info) {
		file.Close()
		return nil, errFilesChanged
	}
	return file, nil
}

func openGrantedRegular(lease *directoryLease, relativePath string) (*os.File, os.FileInfo, error) {
	if lease == nil || lease.handle == nil || lease.handle.root == nil || lease.handle.retired.Load() {
		return nil, nil, errFilesLease
	}
	parts := strings.Split(relativePath, "/")
	for index := 1; index < len(parts); index++ {
		info, err := lease.handle.root.Lstat(strings.Join(parts[:index], "/"))
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, nil, errFilesPath
		}
	}
	before, err := lease.handle.root.Lstat(relativePath)
	if err != nil || before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return nil, nil, errFilesPath
	}
	file, err := lease.handle.root.OpenFile(relativePath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, errFilesPath
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		file.Close()
		return nil, nil, errFilesChanged
	}
	return file, after, nil
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
