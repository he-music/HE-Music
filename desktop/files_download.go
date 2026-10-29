package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
)

const downloadPrivatePrefix = ".hemusic-download-"
const downloadMaxJobs = 128

var errDownload = errors.New("download request rejected")

// OperationID is a caller-generated 32-byte hex idempotency key. A retry needs
// a new ID and a newly validated request; existing IDs never start a second IO.
type DownloadRequest struct {
	OperationID string `json:"operationId"`
	GrantToken  string `json:"grantToken"`
	URL         string `json:"url"`
	Filename    string `json:"filename"`
}
type DownloadOperation struct {
	OperationID string `json:"operationId"`
}

// Total is zero when unknown. Received counts accepted bytes and never exceeds
// the hard limit. Clients must use Done && Code == "ok", not byte equality.
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
}
type downloadCoordinator struct {
	mu        sync.Mutex
	owner     context.Context
	epoch     uint64
	active    int
	jobs      map[string]*downloadJob
	forgotten map[string]struct{}
	client    *http.Client
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
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$":
		return false
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
		return false
	}
	if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(base, "COM"), "LPT")
		if suffix == "¹" || suffix == "²" || suffix == "³" {
			return false
		}
	}
	return supportedLocalAudioName(name)
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
	fingerprint := sha256.Sum256([]byte(req.GrantToken + "\x00" + req.Filename + "\x00" + req.URL))
	var job *downloadJob
	fresh := false
	err = s.main(ctx, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.owner != ctx || c.epoch != epoch {
			for id, old := range c.jobs {
				c.retireLocked(old)
				delete(c.jobs, id)
			}
			c.forgotten = nil
			c.owner, c.epoch = ctx, epoch
		}
		if _, forgotten := c.forgotten[req.OperationID]; forgotten {
			return errDownload
		}
		if old := c.jobs[req.OperationID]; old != nil {
			if old.retired || old.fingerprint != fingerprint {
				return errDownload
			}
			return nil
		}
		if c.active >= 2 || len(c.jobs) >= downloadMaxJobs {
			return errFilesBusy
		}
		op, cancel := context.WithCancel(lease.Context())
		job = &downloadJob{lease: lease, fingerprint: fingerprint, ctx: op, cancel: cancel, commit: newFileCommit(), done: make(chan struct{}), state: DownloadState{OperationID: req.OperationID, Code: "running", Filename: req.Filename}}
		c.jobs[req.OperationID] = job
		c.active++
		fresh = true
		retire := func() { c.mu.Lock(); defer c.mu.Unlock(); c.retireLocked(job) }
		job.stopGrant = context.AfterFunc(lease.handle.leaseContext, retire)
		job.stopOwner = context.AfterFunc(ctx, retire)
		return nil
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
	root := j.lease.handle.root
	nonce, err := newDirectoryToken()
	if err != nil {
		return
	}
	tmp := downloadPrivatePrefix + nonce
	file, err := root.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return
	}
	// Cleanup finishes before run releases the lease, returns a permit or closes done.
	var closeFileOnce sync.Once
	var fileCloseErr error
	closeFile := func() { closeFileOnce.Do(func() { fileCloseErr = file.Close() }) }
	stopFile := context.AfterFunc(j.ctx, closeFile)
	defer func() {
		stopFile()
		closeFile()
		if err := fileCloseErr; err != nil && out.Code == "ok" {
			out.Code = "cleanup_failed"
			out.Ref = nil
		}
		if err := root.Remove(tmp); err != nil {
			out.ResidualName = tmp
			out.Code = "cleanup_failed"
			out.Ref = nil
		}
		if j.ctx.Err() != nil {
			out.Code = "cancelled"
			if errors.Is(j.ctx.Err(), context.DeadlineExceeded) {
				out.Code = "timeout"
			}
			out.Ref = nil
		}
	}()
	req, err := http.NewRequestWithContext(j.ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		out.Code = "invalid_request"
		return
	}
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := c.client.Do(req)
	if err != nil {
		out.Code = "network_error"
		return
	}
	var closeBodyOnce sync.Once
	var bodyCloseErr error
	closeBody := func() { closeBodyOnce.Do(func() { bodyCloseErr = resp.Body.Close() }) }
	stopBody := context.AfterFunc(j.ctx, closeBody)
	defer func() {
		stopBody()
		closeBody()
		if bodyCloseErr != nil && out.Code == "ok" {
			out.Code = "cleanup_failed"
			out.Ref = nil
		}
	}()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Range") != "" || resp.Uncompressed || (resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") {
		out.Code = "http_rejected"
		return
	}
	if resp.ContentLength > 0 {
		out.Total = resp.ContentLength
	}
	c.mu.Lock()
	j.state.Total = out.Total
	c.mu.Unlock()
	buf := make([]byte, 32<<10)
	for {
		if j.ctx.Err() != nil {
			return
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			written, writeErr := file.Write(buf[:n])
			out.Received += int64(written)
			c.mu.Lock()
			j.state.Received = out.Received
			c.mu.Unlock()
			if writeErr != nil || written != n {
				return
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			out.Code = "network_error"
			return
		}
		if n == 0 {
			out.Code = "network_error"
			return
		}
	}
	if resp.ContentLength >= 0 && out.Received != resp.ContentLength {
		out.Code = "http_rejected"
		return
	}
	reader := metadataReader{ctx: j.ctx, file: file}
	info, err := metadata.ParseScan(reader, out.Received)
	if err != nil {
		out.Code = "payload_rejected"
		return
	}
	if !localAudioContainerMatches(info.Container, out.Filename) {
		out.Code = "unsupported"
		return
	}
	// Parsed tags are deliberately discarded, so cached results contain no pictures,
	// attachments or unbounded tag strings. The parent may read metadata using Ref.
	if err = metadata.CompareAudioPayload(j.ctx, reader, out.Received, reader, out.Received); err != nil {
		out.Code = "payload_rejected"
		return
	}
	if file.Sync() != nil {
		return
	}
	if err = s.claimDownloadCommit(j); err != nil {
		out.Code = "revoked"
		return
	}
	if err = root.Link(tmp, out.Filename); err != nil {
		out.Code = "atomic_commit_failed"
		if errors.Is(err, os.ErrExist) {
			out.Code = "conflict"
		}
		return
	}
	out.Committed = true
	c.mu.Lock()
	j.state.Committed = true
	c.mu.Unlock()
	// Never delete or roll back the published name after this point.
	published, err := root.Lstat(out.Filename)
	original, statErr := file.Stat()
	if err != nil || statErr != nil || !sameLocalFileInfo(published, original) {
		out.Code = "conflict"
		return
	}
	dir, err := root.Open(".")
	if err != nil {
		out.Code = "sync_failed"
		return
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	if syncErr != nil || closeErr != nil {
		out.Code = "sync_failed"
		return
	}
	ref, registered, err := s.registerLocalFile(j.lease, out.Filename)
	if err != nil {
		out.Code = "registration_failed"
		return
	}
	registeredInfo, statErr := registered.Stat()
	closeErr = registered.Close()
	if statErr != nil || closeErr != nil || !sameLocalFileInfo(original, registeredInfo) {
		out.Code = "conflict"
		return
	}
	out.Ref = ref
	out.Code = "ok"
	return
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
