package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/metadata"
)

const (
	downloadPrivatePrefix = ".hemusic-download-"
	downloadMaxJobs       = 128
)

var errDownload = errors.New("download request rejected")

// OperationID is a caller-generated 32-byte hex idempotency key. A retry needs
// a new ID and a newly validated request; existing IDs never start a second IO.
type DownloadRequest struct {
	OperationID string           `json:"operationId"`
	GrantToken  string           `json:"grantToken"`
	URL         string           `json:"url"`
	Filename    string           `json:"filename"`
	Options     *DownloadOptions `json:"options,omitempty"`
}
type DownloadOperation struct {
	OperationID string `json:"operationId"`
}

// Total is zero when unknown. Received counts streamed audio bytes without a
// song-size cap. Clients must inspect Done, Code and Committed, not byte equality.
type DownloadState struct {
	OperationID  string        `json:"operationId"`
	Code         string        `json:"code"`
	Done         bool          `json:"done"`
	Received     int64         `json:"received"`
	Total        int64         `json:"total"`
	Committed    bool          `json:"committed"`
	Filename     string        `json:"filename,omitempty"`
	ResidualName string        `json:"residualName,omitempty"`
	Ref          *LocalFileRef `json:"ref,omitempty"`
}
type downloadJob struct {
	lease       *directoryLease
	fingerprint [32]byte
	ctx         context.Context
	cancel      context.CancelFunc
	commit      *fileCommit
	state       DownloadState
	done        chan struct{}
	retired     bool
	stopGrant   func() bool
	stopOwner   func() bool
	options     *DownloadOptions
	io          downloadIO
}
type downloadCoordinator struct {
	mu        sync.Mutex
	owner     context.Context
	epoch     uint64
	active    int
	jobs      map[string]*downloadJob
	forgotten map[string]struct{}
	client    *http.Client
	io        downloadIO
}

var downloadCoordinators = struct {
	sync.Mutex
	entries map[*nativeFilesState]*downloadCoordinator
}{entries: make(map[*nativeFilesState]*downloadCoordinator)}

func downloadCoordinatorFor(s *nativeFilesState) *downloadCoordinator {
	downloadCoordinators.Lock()
	defer downloadCoordinators.Unlock()
	c := downloadCoordinators.entries[s]
	if c == nil {
		// No cookie jar, credentials, application headers, proxy environment or logs.
		transport := http.DefaultTransport.(*http.Transport).Clone()
		configureDownloadProxyTransport(transport)
		c = &downloadCoordinator{jobs: make(map[string]*downloadJob), client: &http.Client{
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				// Signed query strings must not become a redirect Referer.
				req.Header.Del("Referer")
				if len(via) >= 10 || !downloadURL(req.URL) {
					return errDownload
				}
				return nil
			},
		}}
		downloadCoordinators.entries[s] = c
	}
	return c
}

func downloadURL(u *url.URL) bool {
	return u != nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && u.Opaque == "" && u.Fragment == ""
}

func downloadFilename(name string) bool {
	if len(name) > 240 || !utf8.ValidString(name) || validateLocalRelativePath(name) != nil || strings.ContainsAny(name, "/<>\"|?*") || strings.HasSuffix(name, ".") || strings.TrimSpace(name) != name || strings.HasPrefix(name, ".") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	base := strings.ToUpper(strings.TrimRight(strings.SplitN(name, ".", 2)[0], " ."))
	if reservedDownloadBase(base) {
		return false
	}
	return supportedLocalAudioName(name)
}

func reservedDownloadBase(base string) bool {
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
		return true
	}
	if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(base, "COM"), "LPT")
		return suffix == "¹" || suffix == "²" || suffix == "³"
	}
	return false
}

func (f *NativeFiles) StartDownload(ctx context.Context, epoch uint64, req DownloadRequest) (DownloadOperation, error) {
	return f.state.startDownload(ctx, epoch, req)
}

func (s *nativeFilesState) startDownload(ctx context.Context, epoch uint64, req DownloadRequest) (DownloadOperation, error) {
	id, err := decodeDirectoryToken(req.OperationID)
	u, urlErr := url.Parse(req.URL)
	if err != nil || len(id) != 32 || len(req.URL) > 8192 || urlErr != nil || !downloadURL(u) || !downloadFilename(req.Filename) {
		return DownloadOperation{}, errDownload
	}
	lease, err := s.acquireDirectory(ctx, epoch, req.GrantToken)
	if err != nil {
		return DownloadOperation{}, err
	}
	c := downloadCoordinatorFor(s)
	options, targetErr := downloadNativeOptionsSnapshot(req.Options)
	if targetErr != nil {
		lease.Release()
		return DownloadOperation{}, errDownload
	}
	target, targetErr := downloadNativeTarget(req.Filename, options)
	if targetErr != nil {
		lease.Release()
		return DownloadOperation{}, errDownload
	}
	fingerprint := sha256.Sum256([]byte(req.GrantToken + "\x00" + target + "\x00" + req.URL + "\x00" + downloadNativeOptionsFingerprint(options)))
	var job *downloadJob
	fresh := false
	err = s.main(ctx, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		job, fresh, err = c.acceptDownload(lease, req, fingerprint, options)
		return err
	})
	if err != nil || !fresh {
		lease.Release()
	}
	if err != nil {
		return DownloadOperation{}, err
	}
	if fresh {
		go c.run(s, job, req.URL)
	}
	return DownloadOperation{OperationID: req.OperationID}, nil
}

func (c *downloadCoordinator) acceptDownload(lease *directoryLease, req DownloadRequest, fingerprint [sha256.Size]byte, options *DownloadOptions) (*downloadJob, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.owner != lease.owner || c.epoch != lease.epoch {
		for id, old := range c.jobs {
			c.retireLocked(old)
			delete(c.jobs, id)
		}
		c.forgotten = nil
		c.owner, c.epoch = lease.owner, lease.epoch
	}
	if _, forgotten := c.forgotten[req.OperationID]; forgotten {
		return nil, false, errDownload
	}
	if old := c.jobs[req.OperationID]; old != nil {
		if old.retired || old.fingerprint != fingerprint {
			return nil, false, errDownload
		}
		return nil, false, nil
	}
	if c.active >= 2 || len(c.jobs) >= downloadMaxJobs {
		return nil, false, errFilesBusy
	}
	op, cancel := context.WithCancel(lease.Context())
	job := &downloadJob{lease: lease, fingerprint: fingerprint, ctx: op, cancel: cancel, commit: newFileCommit(), done: make(chan struct{}), state: DownloadState{OperationID: req.OperationID, Code: "running", Filename: req.Filename}, options: options, io: c.io}
	c.jobs[req.OperationID] = job
	c.active++
	retire := func() { c.mu.Lock(); defer c.mu.Unlock(); c.retireLocked(job) }
	job.stopGrant = context.AfterFunc(lease.handle.leaseContext, retire)
	job.stopOwner = context.AfterFunc(lease.owner, retire)
	return job, true, nil
}

func (c *downloadCoordinator) retireLocked(j *downloadJob) {
	if j.retired {
		return
	}
	j.retired = true
	j.cancel()
	j.state.Ref = nil
	// Keep a bounded session tombstone: a revoked ID cannot run again.
	j.stopGrant()
	j.stopOwner()
	// The active permit and done channel belong to the worker until real cleanup.
}

func (c *downloadCoordinator) access(s *nativeFilesState, ctx context.Context, epoch uint64, id string, cancel bool) (DownloadState, error) {
	var result DownloadState
	err := s.main(ctx, func(parent *mygo.Window) error {
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		j := c.jobs[id]
		if j == nil || j.retired || j.lease.owner != ctx || j.lease.epoch != epoch {
			return errDownload
		}
		grant, ok := s.grants[j.lease.token]
		if !ok || grant.handle != j.lease.handle || grant.handle.retired.Load() || parent != j.lease.parent {
			return errFilesLease
		}
		if cancel && !j.state.Done {
			s.invalidateFileCommit(j.commit)
			j.cancel()
		}
		result = j.state
		if result.Ref != nil {
			ref := *result.Ref
			result.Ref = &ref
		}
		return nil
	})
	return result, err
}

func (f *NativeFiles) ReadDownloadState(ctx context.Context, epoch uint64, id string) (DownloadState, error) {
	return downloadCoordinatorFor(&f.state).access(&f.state, ctx, epoch, id, false)
}

func (f *NativeFiles) CancelDownload(ctx context.Context, epoch uint64, id string) (DownloadState, error) {
	return downloadCoordinatorFor(&f.state).access(&f.state, ctx, epoch, id, true)
}

func (c *downloadCoordinator) run(s *nativeFilesState, j *downloadJob, rawURL string) {
	result := c.transfer(s, j, rawURL)
	s.finishFileCommit(j.commit)
	j.cancel()
	j.lease.Release()
	finish := func(valid bool) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if !valid || j.retired || c.jobs[result.OperationID] != j {
			result.Ref = nil
			result.Code = "revoked"
		}
		result.Done = true
		j.options = nil
		j.state = result
		c.active--
		close(j.done)
	}
	err := s.main(j.lease.owner, func(parent *mygo.Window) error {
		grant, ok := s.grants[j.lease.token]
		valid := s.owns(j.lease.owner, j.lease.epoch) && parent == j.lease.parent && ok && grant.handle == j.lease.handle && !grant.handle.retired.Load()
		finish(valid)
		return nil
	})
	if err != nil {
		finish(false)
	}
}

func (c *downloadCoordinator) transfer(s *nativeFilesState, j *downloadJob, rawURL string) (out DownloadState) {
	c.mu.Lock()
	out = j.state
	c.mu.Unlock()
	out.Code = "io_error"
	transfer := downloadTransfer{coordinator: c, job: j, out: &out, stage: "prepare_target"}
	var err error
	defer func() { logDownloadFailure(transfer.stage, transfer.status, err, out) }()
	target, err := downloadNativeTarget(j.state.Filename, j.options)
	if err != nil {
		out.Code = "invalid_request"
		return out
	}
	root, targetName, parent, err := downloadWorkTarget(j.lease.handle.root, target)
	if err != nil {
		out.Code = "invalid_request"
		return out
	}
	if root != j.lease.handle.root {
		defer root.Close()
	}
	var owned []*downloadOwnedPrivate
	defer func() { transfer.cleanupPrivate(owned, target) }()
	transfer.stage = "create_work_file"
	work, err := downloadNewPrivate(root, "work", j.io)
	if work != nil {
		owned = append(owned, work)
	}
	if err != nil {
		return out
	}
	stopFile := context.AfterFunc(j.ctx, func() {
		if j.commit.phase.Load() != fileCommitClaimed {
			_ = work.close()
		}
	})
	defer stopFile()
	resp, closeResponse, err := transfer.request(rawURL)
	if err != nil {
		return out
	}
	defer closeResponse()
	if err = transfer.receive(resp, work.file); err != nil {
		return out
	}
	if err = transfer.validateAudio(work.file, target); err != nil {
		return out
	}
	if err = transfer.editAudio(root, work, &owned); err != nil {
		return out
	}
	transfer.stage = "sync_audio"
	if err = work.sync(); err != nil {
		return out
	}
	transfer.stage = "prepare_sidecars"
	sidecars, err := downloadNativePrepareSidecars(j.ctx, c.client, root, targetName, j.options, j.io, &owned)
	if err != nil {
		return out
	}
	if err = transfer.authorize(s, target, parent); err != nil {
		return out
	}
	original, err := transfer.publishAudio(root, targetName, work)
	if err != nil {
		return out
	}
	if err = transfer.registerAudio(s, target, parent, original); err != nil {
		return out
	}
	err = transfer.publishSidecars(root, sidecars)
	return out
}

// The operation deadline and explicit cancel share the claim gate. Once claimed,
// cancellation cannot promise that the subsequent no-replace Link did not occur.
func (s *nativeFilesState) claimDownloadCommit(j *downloadJob) error {
	return s.main(j.lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(j.lease, parent); err != nil {
			return err
		}
		j.commit.mu.Lock()
		defer j.commit.mu.Unlock()
		if err := j.ctx.Err(); err != nil {
			return err
		}
		if j.commit.phase.Load() != fileCommitActive {
			return errFilesBusy
		}
		if !j.lease.handle.retainLease() {
			return errFilesLease
		}
		j.commit.handle, j.commit.state = j.lease.handle, s
		j.commit.phase.Store(fileCommitClaimed)
		return nil
	})
}

// downloadNativeOpenTarget to obtain a Root for the validated child directory.
func downloadNativeParentInfo(root *os.Root, target string) (os.FileInfo, error) {
	dir := path.Dir(target)
	if dir == "." {
		return root.Stat(".")
	}
	parent, err := root.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	return parent.Stat(".")
}

func downloadNativeVerifyRoute(root *os.Root, target string) error {
	directory := path.Dir(target)
	if directory == "." {
		return nil
	}
	prefix := ""
	for part := range strings.SplitSeq(directory, "/") {
		if prefix == "" {
			prefix = part
		} else {
			prefix += "/" + part
		}
		info, err := root.Lstat(prefix)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errFilesChanged
		}
		next, err := root.OpenRoot(prefix)
		if err != nil {
			return errFilesChanged
		}
		after, err := next.Stat(".")
		_ = next.Close()
		if err != nil || !os.SameFile(info, after) {
			return errFilesChanged
		}
	}
	return nil
}

// downloadNativeOpenTarget creates and opens only validated relative children.
// No renderer path is passed to os.Open or filepath operations.
func downloadNativeOpenTarget(root *os.Root, target string) (*os.Root, string, error) {
	if err := validateLocalRelativePath(target); err != nil {
		return nil, "", errDownloadOptions
	}
	directory := path.Dir(target)
	if directory == "." {
		return root, path.Base(target), nil
	}
	current := root
	parts := strings.Split(directory, "/")
	opened := make([]*os.Root, 0, len(parts))
	owned := true
	defer func() {
		if owned {
			for _, r := range opened {
				_ = r.Close()
			}
		}
	}()
	for _, part := range parts {
		before, err := current.Lstat(part)
		if errors.Is(err, os.ErrNotExist) {
			if mkdirErr := current.Mkdir(part, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
				return nil, "", mkdirErr
			}
			before, err = current.Lstat(part)
		}
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			return nil, "", errDownloadOptions
		}
		next, err := current.OpenRoot(part)
		if err != nil {
			return nil, "", errDownloadOptions
		}
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			_ = next.Close()
			return nil, "", errFilesChanged
		}
		opened = append(opened, next)
		current = next
	}
	// Transfer owns the returned child; close only the intermediate handles.
	child := current
	for _, r := range opened[:len(opened)-1] {
		_ = r.Close()
	}
	owned = false
	return child, path.Base(target), nil
}

// downloadNativeMetadata stages metadata on the private audio file. Empty
// lyrics are intentionally skipped: WriteLyrics requests an optional value and
// must not reject an otherwise valid audio download.
func downloadNativeMetadata(ctx context.Context, client *http.Client, root *os.Root, audio *os.File, name string, options *DownloadOptions) error {
	if options == nil || options.Metadata == nil {
		return nil
	}
	m := options.Metadata
	var picture *metadata.Picture
	if options.WriteCover && m.CoverURL != "" {
		data, mime, err := downloadNativeFetchCover(ctx, client, m.CoverURL)
		if err != nil {
			return err
		}
		picture = &metadata.Picture{MIME: mime, Type: 3, Data: data}
	}

	patch := downloadMetadataPatch(options, picture)
	if patch.Title == nil && patch.Album == nil && patch.Artists == nil && patch.Lyrics == nil && patch.Pictures == nil {
		return nil
	}
	info, err := audio.Stat()
	if err != nil {
		return err
	}
	if !metadataPatchWithinLimit(patch) {
		return errDownloadOptions
	}
	if err := metadata.EditWorkingCopy(ctx, audio, info.Size(), patch); err != nil {
		return err
	}
	edited, err := audio.Stat()
	if err != nil {
		return err
	}
	parsed, err := metadata.Parse(audio, edited.Size())
	if err != nil || !metadataPatchMatches(parsed, patch) {
		return errDownloadOptions
	}
	return nil
}

func downloadMetadataPatch(options *DownloadOptions, picture *metadata.Picture) metadata.Patch {
	patch := metadata.Patch{}
	m := options.Metadata
	if options.WriteMetadata {
		patch.Title, patch.Album, patch.Artists = &m.Title, &m.Album, &m.Artists
	}
	if options.WriteLyrics && m.Lyrics != "" {
		patch.Lyrics = &m.Lyrics
	}
	if picture != nil {
		pictures := []metadata.Picture{*picture}
		patch.Pictures = &pictures
	}
	return patch
}
