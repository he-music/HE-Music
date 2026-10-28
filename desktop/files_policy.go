package main

import (
	"context"
	"encoding/hex"
	"errors"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
)

var errFilesOwner = errors.New("file session is no longer active")
var errFilesBusy = errors.New("native file operation is busy")
var errFilesPicker = errors.New("native file selection failed")
var errFilesToken = errors.New("invalid directory grant")

const fileOpActive uint32 = 0
const fileOpInvalid uint32 = 1
const fileOpCommitting uint32 = 2

type FileSession struct {
	Epoch uint64 `json:"epoch"`
}
type DefaultDirectoryKind string

const (
	DefaultDirectoryMusic     DefaultDirectoryKind = "music"
	DefaultDirectoryDownloads DefaultDirectoryKind = "downloads"
)

type DefaultDirectoryResult struct {
	Kind        DefaultDirectoryKind `json:"kind"`
	DisplayPath string               `json:"displayPath"`
	// A display path is never an authorization token.
	Authorized bool `json:"authorized"`
}
type DirectoryGrant struct {
	Token       string `json:"token"`
	DisplayPath string `json:"displayPath"`
	Epoch       uint64 `json:"epoch"`
}
type DirectorySelection struct {
	Status        DirectorySelectionStatus `json:"status"`
	Grant         *DirectoryGrant          `json:"grant"`
	Relation      DirectoryRelation        `json:"relation"`
	ExistingToken string                   `json:"existingToken"`
}
type SettingsImportResult struct {
	Status   SettingsImportStatus      `json:"status"`
	Document *RendererSettingsDocument `json:"document"`
}
type SettingsExportResult struct {
	Status SettingsExportStatus `json:"status"`
}

type filePicker interface {
	Open(mygo.OpenDialogOptions) ([]string, error)
	Save(mygo.SaveDialogOptions) (string, error)
}

type fileOperation struct {
	owner  context.Context
	epoch  uint64
	parent *mygo.Window
	phase  atomic.Uint32
}

type ownedDirectory struct {
	grant  DirectoryGrant
	handle *directoryHandle
}

// State is accessed only inside dispatch/main closures. Operations carry immutable
// captures and an atomic commit gate; no mutex is held across main dispatch or IO.
type nativeFilesState struct {
	main        func(context.Context, func(*mygo.Window) error) error
	dispatch    func(func())
	picker      filePicker
	defaultPath func(DefaultDirectoryKind) (string, error)
	owner       context.Context
	epoch       uint64
	busy        *fileOperation
	grants      map[string]ownedDirectory
	fileEntries map[string]*localFileEntry
	cleanup     sync.WaitGroup
}

func (s *nativeFilesState) session(ctx context.Context) (FileSession, error) {
	var result FileSession
	err := s.main(ctx, func(*mygo.Window) error {
		if s.owner != ctx {
			s.revoke()
			s.owner = ctx
		}
		result.Epoch = s.epoch
		return nil
	})
	return result, err
}

func (s *nativeFilesState) owns(ctx context.Context, epoch uint64) bool {
	return s.owner == ctx && ctx.Err() == nil && epoch != 0 && epoch == s.epoch
}

func (s *nativeFilesState) begin(ctx context.Context, epoch uint64) (*fileOperation, error) {
	var op *fileOperation
	err := s.main(ctx, func(parent *mygo.Window) error {
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		if s.busy != nil {
			return errFilesBusy
		}
		op = &fileOperation{owner: ctx, epoch: epoch, parent: parent}
		s.busy = op
		return nil
	})
	return op, err
}

func (s *nativeFilesState) check(op *fileOperation) error {
	return s.main(op.owner, func(parent *mygo.Window) error {
		if !s.owns(op.owner, op.epoch) || s.busy != op || parent != op.parent || op.phase.Load() == fileOpInvalid {
			return errFilesOwner
		}
		return nil
	})
}

func (s *nativeFilesState) finish(op *fileOperation) {
	s.dispatch(func() {
		if s.busy == op {
			s.busy = nil
		}
	})
}

// The CAS is the save linearization point. Invalidation that wins it prevents
// rename. Once committing, navigation cannot roll back the authorized replace.
func (s *nativeFilesState) claimCommit(op *fileOperation) error {
	return s.main(op.owner, func(parent *mygo.Window) error {
		if !s.owns(op.owner, op.epoch) || s.busy != op || parent != op.parent || op.owner.Err() != nil || !op.phase.CompareAndSwap(fileOpActive, fileOpCommitting) {
			return errFilesOwner
		}
		return nil
	})
}

func (s *nativeFilesState) closeDirectories(handles []*directoryHandle) {
	if len(handles) == 0 {
		return
	}
	for _, handle := range handles {
		s.dropFileEntries(handle)
		handle.retire(s)
	}
}

// Main actor only: never clear Busy until the outstanding panel/IO actually exits.
func (s *nativeFilesState) revoke() {
	if s.busy != nil {
		s.busy.phase.CompareAndSwap(fileOpActive, fileOpInvalid)
	}
	handles := make([]*directoryHandle, 0, len(s.grants))
	for _, entry := range s.grants {
		handles = append(handles, entry.handle)
	}
	s.grants = nil
	s.fileEntries = nil
	s.owner = nil
	s.epoch++
	s.closeDirectories(handles)
}

func (s *nativeFilesState) teardown(ctx context.Context, epoch uint64) error {
	return s.main(ctx, func(*mygo.Window) error {
		if s.owner == nil && s.epoch == epoch+1 {
			return nil
		}
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		s.revoke()
		return nil
	})
}

func (s *nativeFilesState) defaultDirectory(ctx context.Context, epoch uint64, kind DefaultDirectoryKind) (DefaultDirectoryResult, error) {
	result := DefaultDirectoryResult{Kind: kind}
	if kind != DefaultDirectoryMusic && kind != DefaultDirectoryDownloads {
		return result, errDirectory
	}
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return result, err
	}
	defer s.finish(op)
	path, err := s.defaultPath(kind)
	if err != nil {
		return result, errDirectory
	}
	if err := s.check(op); err != nil {
		return result, err
	}
	result.DisplayPath = path
	return result, nil
}

func (s *nativeFilesState) chooseDirectory(ctx context.Context, epoch uint64) (DirectorySelection, error) {
	var result DirectorySelection
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return result, err
	}
	defer s.finish(op)
	paths, pickErr := s.picker.Open(mygo.OpenDialogOptions{Parent: op.parent, Directory: true, CreateDirectories: true})
	if err := s.check(op); err != nil {
		return result, err
	}
	if pickErr != nil {
		return result, errFilesPicker
	}
	if len(paths) == 0 {
		result.Status = "cancelled"
		return result, nil
	}
	if len(paths) != 1 {
		return result, errFilesPicker
	}
	handle, err := openDirectoryHandle(paths[0])
	if err != nil {
		return result, err
	}
	accepted := false
	defer func() {
		if !accepted {
			_ = handle.root.Close()
		}
	}()
	token, err := newDirectoryToken()
	if err != nil {
		return result, err
	}
	overlaps, err := s.directoryOverlaps(op, handle)
	if err != nil {
		return result, err
	}
	err = s.main(ctx, func(parent *mygo.Window) error {
		if !s.owns(ctx, epoch) || s.busy != op || parent != op.parent || op.phase.Load() != fileOpActive {
			return errFilesOwner
		}
		for _, overlap := range overlaps {
			if entry, exists := s.grants[overlap.token]; exists && entry.handle == overlap.handle {
				result = DirectorySelection{Status: DirectoryOverlapping, Relation: overlap.relation, ExistingToken: overlap.token}
				return nil
			}
		}
		if len(s.grants) >= 32 {
			return errDirectory
		}
		grant := DirectoryGrant{Token: token, DisplayPath: handle.canonical, Epoch: epoch}
		if s.grants == nil {
			s.grants = make(map[string]ownedDirectory)
		}
		s.grants[token] = ownedDirectory{grant: grant, handle: handle}
		accepted = true
		result = DirectorySelection{Status: "selected", Grant: &grant}
		return nil
	})
	return result, err
}

func (s *nativeFilesState) revokeDirectory(ctx context.Context, epoch uint64, token string) error {
	return s.main(ctx, func(*mygo.Window) error {
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		decoded, err := hex.DecodeString(token)
		if err != nil || len(decoded) != 32 {
			return errFilesToken
		}
		if entry, exists := s.grants[token]; exists {
			delete(s.grants, token)
			s.closeDirectories([]*directoryHandle{entry.handle})
		}
		return nil
	})
}

func (s *nativeFilesState) importSettings(ctx context.Context, epoch uint64) (SettingsImportResult, error) {
	var result SettingsImportResult
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return result, err
	}
	defer s.finish(op)
	paths, pickErr := s.picker.Open(mygo.OpenDialogOptions{Parent: op.parent, Filters: []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json"}}}})
	if err := s.check(op); err != nil {
		return result, err
	}
	if pickErr != nil {
		return result, errFilesPicker
	}
	if len(paths) == 0 {
		return SettingsImportResult{Status: "cancelled"}, nil
	}
	if len(paths) != 1 {
		return result, errFilesPicker
	}
	document, err := readSelectedSettings(paths[0])
	if err != nil {
		return result, err
	}
	if err := s.check(op); err != nil {
		return result, err
	}
	return SettingsImportResult{Status: "selected", Document: &document}, nil
}

func (s *nativeFilesState) exportSettings(ctx context.Context, epoch uint64, settings RendererSettings) (SettingsExportResult, error) {
	var result SettingsExportResult
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return result, err
	}
	defer s.finish(op)
	data, err := encodeRendererSettings(settings)
	if err != nil {
		return result, err
	}
	if err := s.check(op); err != nil {
		return result, err
	}
	path, pickErr := s.picker.Save(mygo.SaveDialogOptions{Parent: op.parent, DefaultPath: "HE-Music_Settings.json", Filters: []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json"}}}})
	if err := s.check(op); err != nil {
		return result, err
	}
	if pickErr != nil {
		return result, errFilesPicker
	}
	if path == "" {
		return SettingsExportResult{Status: "cancelled"}, nil
	}
	save, err := prepareSettingsSave(path, data)
	if err != nil {
		return result, err
	}
	defer save.cleanup()
	if err := s.claimCommit(op); err != nil {
		return result, err
	}
	if err := save.replace(); err != nil {
		return result, err
	}
	if err := s.check(op); err != nil {
		return result, err
	}
	return SettingsExportResult{Status: "saved"}, nil
}
