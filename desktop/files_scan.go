package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
)

const (
	scanPageSize            = 32
	scanQueueSize           = 64
	scanMaxOperations       = 8
	scanMaxDepth            = 16
	scanMaxItems            = 10000
	scanMaxFileBytes  int64 = 32 << 20
	scanMaxBytes      int64 = 512 << 20
	scanLifetime            = 5 * time.Minute
)

var errFilesScan = errors.New("invalid or expired file operation")
var errFilesScanCursor = errors.New("invalid scan cursor")

type ScanOperation struct {
	OperationID string `json:"operationId"`
}
type ScanEntry struct {
	Ref          LocalFileRef  `json:"ref"`
	RelativePath string        `json:"relativePath"`
	Filename     string        `json:"filename"`
	Size         int64         `json:"size"`
	Metadata     metadata.Info `json:"metadata"`
}
type ScanIssue struct {
	RelativePath string `json:"relativePath"`
	Code         string `json:"code"`
}
type ScanPage struct {
	OperationID string      `json:"operationId"`
	Entries     []ScanEntry `json:"entries"`
	NextCursor  string      `json:"nextCursor"`
	Done        bool        `json:"done"`
	Issues      []ScanIssue `json:"issues"`
}
type scanEvent struct {
	entry *ScanEntry
	issue *ScanIssue
}
type fileScan struct {
	state    *nativeFilesState
	lease    *directoryLease
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	queue    chan scanEvent
	finished chan struct{}
	mu       sync.Mutex // Serializes cursor consumption, never held across actor calls.
	cursor   uint64
}

// The existing state is actor-owned and intentionally unchanged. This bounded
// registry holds only transient scan jobs; cancellation/expiry removes each job.
var fileScans = struct {
	sync.Mutex
	jobs map[string]*fileScan
}{jobs: make(map[string]*fileScan)}

// StartScan starts a read-only job. An empty cursor requests its first page.
func (f *NativeFiles) StartScan(ctx context.Context, epoch uint64, grantToken string) (ScanOperation, error) {
	return f.state.startScan(ctx, epoch, grantToken)
}

func (s *nativeFilesState) startScan(ctx context.Context, epoch uint64, token string) (ScanOperation, error) {
	lease, err := s.acquireDirectory(ctx, epoch, token)
	if err != nil {
		return ScanOperation{}, err
	}
	id, err := newDirectoryToken()
	if err != nil {
		lease.Release()
		return ScanOperation{}, err
	}
	// The worker keeps an independent hold until all IO exits, paired with
	// releaseWorker even when cancellation or page teardown happens first.
	err = s.main(ctx, func(parent *mygo.Window) error {
		if parent != lease.parent || !s.owns(ctx, epoch) || !lease.handle.retainLease() {
			return errFilesLease
		}
		return nil
	})
	if err != nil {
		lease.Release()
		return ScanOperation{}, err
	}
	jobCtx, cancel := context.WithTimeout(ctx, scanLifetime)
	// Completed but unread jobs must also expire when their grant is revoked.
	stopGrant := context.AfterFunc(lease.handle.leaseContext, cancel)
	job := &fileScan{state: s, lease: lease, id: id, ctx: jobCtx, cancel: cancel, queue: make(chan scanEvent, scanQueueSize), finished: make(chan struct{})}
	fileScans.Lock()
	count := 0
	for _, candidate := range fileScans.jobs {
		if candidate.state == s {
			count++
		}
	}
	if count < scanMaxOperations {
		fileScans.jobs[id] = job
	}
	fileScans.Unlock()
	if count >= scanMaxOperations {
		cancel()
		stopGrant()
		job.releaseWorker()
		lease.Release()
		return ScanOperation{}, errFilesBusy
	}
	context.AfterFunc(jobCtx, func() {
		defer stopGrant()
		<-job.finished
		// References belong to the grant's bounded, deduplicated index. Dropping
		// a cancelled job must not invalidate refs published by another scan.
		for range job.queue {
		}
		fileScans.Lock()
		if fileScans.jobs[id] == job {
			delete(fileScans.jobs, id)
		}
		fileScans.Unlock()
	})
	if err := s.checkLease(lease); err != nil {
		cancel()
		lease.Release()
		job.releaseWorker()
		close(job.queue)
		close(job.finished)
		return ScanOperation{}, err
	}
	go job.run()
	return ScanOperation{OperationID: id}, nil
}

func (j *fileScan) releaseWorker() {
	j.state.dispatch(func() {
		if j.lease.handle.releaseLease() == 0 && j.lease.handle.retired.Load() {
			j.lease.handle.closeWhenIdle(j.state)
		}
	})
}

func (s *nativeFilesState) scanJob(ctx context.Context, epoch uint64, id string) (*fileScan, error) {
	fileScans.Lock()
	job := fileScans.jobs[id]
	fileScans.Unlock()
	if job == nil || job.state != s || job.lease.owner != ctx || job.lease.epoch != epoch || job.ctx.Err() != nil {
		return nil, errFilesScan
	}
	err := s.main(ctx, func(parent *mygo.Window) error {
		entry, exists := s.grants[job.lease.token]
		if !s.owns(ctx, epoch) || parent != job.lease.parent || !exists ||
			entry.handle != job.lease.handle || entry.grant.Epoch != epoch ||
			entry.handle.retired.Load() || job.ctx.Err() != nil {
			return errFilesScan
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

// ReadScanPage consumes at most scanPageSize queued events. Empty, non-final
// pages are valid while IO runs; every successful call advances the cursor.
func (f *NativeFiles) ReadScanPage(ctx context.Context, epoch uint64, operationID, cursor string) (ScanPage, error) {
	return f.state.readScanPage(ctx, epoch, operationID, cursor)
}
func (s *nativeFilesState) readScanPage(ctx context.Context, epoch uint64, id, cursor string) (ScanPage, error) {
	job, err := s.scanJob(ctx, epoch, id)
	if err != nil {
		return ScanPage{}, err
	}
	job.mu.Lock()
	expected := ""
	if job.cursor != 0 {
		expected = strconv.FormatUint(job.cursor, 10)
	}
	if cursor != expected {
		job.mu.Unlock()
		return ScanPage{}, errFilesScanCursor
	}
	page := ScanPage{OperationID: id, Entries: []ScanEntry{}, Issues: []ScanIssue{}}
drain:
	for n := 0; n < scanPageSize; n++ {
		select {
		case event, ok := <-job.queue:
			if !ok {
				page.Done = true
				break drain
			}
			if event.entry != nil {
				page.Entries = append(page.Entries, *event.entry)
			}
			if event.issue != nil {
				page.Issues = append(page.Issues, *event.issue)
			}
		default:
			break drain
		}
	}
	job.cursor++
	page.NextCursor = strconv.FormatUint(job.cursor, 10)
	job.mu.Unlock()
	// The final authorization check is the publication gate, after queue access.
	if _, err := s.scanJob(ctx, epoch, id); err != nil {
		return ScanPage{}, err
	}
	if page.Done {
		fileScans.Lock()
		if fileScans.jobs[id] == job {
			delete(fileScans.jobs, id)
		}
		fileScans.Unlock()
		job.cancel()
	}
	return page, nil
}

func (f *NativeFiles) CancelFileOperation(ctx context.Context, epoch uint64, operationID string) error {
	return f.state.cancelScan(ctx, epoch, operationID)
}
func (s *nativeFilesState) cancelScan(ctx context.Context, epoch uint64, id string) error {
	job, err := s.scanJob(ctx, epoch, id)
	if err != nil {
		return err
	}
	job.cancel()
	return nil
}

func (j *fileScan) emit(event scanEvent) bool {
	if j.ctx.Err() != nil {
		return false
	}
	select {
	case j.queue <- event:
		return j.ctx.Err() == nil
	case <-j.ctx.Done():
		return false
	}
}
func (j *fileScan) issue(path, code string) bool {
	return j.emit(scanEvent{issue: &ScanIssue{RelativePath: path, Code: code}})
}
func (j *fileScan) run() {
	defer close(j.finished)
	defer j.releaseWorker()
	defer j.lease.Release()
	defer close(j.queue)
	items := 0
	var bytes int64
	j.walk("", 0, &items, &bytes)
}

func (j *fileScan) walk(relative string, depth int, items *int, bytes *int64) bool {
	if j.ctx.Err() != nil {
		return false
	}
	root := j.lease.handle.root
	if relative != "" {
		parts := strings.Split(relative, "/")
		for n := 1; n <= len(parts); n++ {
			info, err := root.Lstat(strings.Join(parts[:n], "/"))
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return j.issue(relative, "path")
			}
		}
	}
	path := relative
	if path == "" {
		path = "."
	}
	before, err := root.Lstat(path)
	if err != nil {
		return j.issue(relative, "read-directory")
	}
	dir, err := root.OpenRoot(path)
	if err != nil {
		return j.issue(relative, "read-directory")
	}
	defer dir.Close()
	after, err := dir.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		return j.issue(relative, "changed")
	}
	file, err := dir.Open(".")
	if err != nil {
		return j.issue(relative, "read-directory")
	}
	defer file.Close()
	for {
		if j.ctx.Err() != nil {
			return false
		}
		entries, readErr := file.ReadDir(scanPageSize)
		for _, entry := range entries {
			if j.ctx.Err() != nil {
				return false
			}
			if *items >= scanMaxItems {
				j.issue(relative, "item-limit")
				return false
			}
			*items++
			rel := entry.Name()
			if relative != "" {
				rel = relative + "/" + rel
			}
			if validateLocalRelativePath(rel) != nil {
				if !j.issue(rel, "path") {
					return false
				}
				continue
			}
			info, err := root.Lstat(rel)
			if err != nil {
				if !j.issue(rel, "stat") {
					return false
				}
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				if !j.issue(rel, "symlink") {
					return false
				}
				continue
			}
			if info.IsDir() {
				if depth >= scanMaxDepth {
					if !j.issue(rel, "depth-limit") {
						return false
					}
					continue
				}
				if !j.walk(rel, depth+1, items, bytes) {
					return false
				}
				continue
			}
			if !info.Mode().IsRegular() {
				if !j.issue(rel, "special-file") {
					return false
				}
				continue
			}
			if info.Size() > scanMaxFileBytes || info.Size() < 0 {
				if !j.issue(rel, "file-byte-limit") {
					return false
				}
				continue
			}
			if info.Size() > scanMaxBytes-*bytes {
				j.issue(rel, "byte-limit")
				return false
			}
			if !j.scanFile(rel, entry.Name(), bytes) {
				return false
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return j.issue(relative, "read-directory")
			}
			return true
		}
	}
}

type scanReaderAt struct {
	ctx  context.Context
	file *os.File
}

func (r scanReaderAt) ReadAt(p []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.file.ReadAt(p, offset)
	if r.ctx.Err() != nil {
		return n, r.ctx.Err()
	}
	return n, err
}

func (j *fileScan) scanFile(relative, filename string, bytes *int64) bool {
	file, before, err := openGrantedRegular(j.lease, relative)
	if err != nil {
		return j.issue(relative, "path")
	}
	defer file.Close()
	if before.Size() > scanMaxFileBytes || before.Size() < 0 {
		return j.issue(relative, "file-byte-limit")
	}
	if before.Size() > scanMaxBytes-*bytes {
		j.issue(relative, "byte-limit")
		return false
	}
	*bytes += before.Size()
	info, parseErr := metadata.ParseScan(scanReaderAt{j.ctx, file}, before.Size())
	after, statErr := file.Stat()
	file.Close()
	if j.ctx.Err() != nil {
		return false
	}
	if statErr != nil || !sameLocalFileInfo(before, after) {
		return j.issue(relative, "changed")
	}
	if parseErr != nil {
		code := "unsupported-or-corrupt"
		if errors.Is(parseErr, metadata.ErrUnsupportedContainer) {
			code = "unsupported"
		}
		return j.issue(relative, code)
	}
	// Registration happens only for parsed files, and the reopened identity must
	// still match the exact file read above. The core bounds the shared index.
	ref, registered, err := j.state.registerLocalFile(j.lease, relative)
	if err != nil {
		if errors.Is(err, errFilesBusy) {
			return j.issue(relative, "reference-limit")
		}
		return j.issue(relative, "changed")
	}
	defer registered.Close()
	registeredInfo, err := registered.Stat()
	registered.Close()
	if err != nil || !sameLocalFileInfo(before, registeredInfo) || j.ctx.Err() != nil {
		if j.ctx.Err() != nil {
			return false
		}
		return j.issue(relative, "changed")
	}
	info = boundedScanInfo(info)
	if !j.emit(scanEvent{entry: &ScanEntry{Ref: *ref, RelativePath: relative, Filename: filename, Size: before.Size(), Metadata: info}}) {
		return false
	}
	return true
}

// Scan metadata is a bounded display view, never an editable full-tag snapshot.
func boundedScanInfo(info metadata.Info) metadata.Info {
	trim := func(value string) string {
		if len(value) <= 1024 {
			return value
		}
		value = value[:1024]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
		return value
	}
	values := func(list []string) []string {
		if len(list) > 8 {
			list = list[:8]
		}
		out := make([]string, len(list))
		for n, value := range list {
			out[n] = trim(value)
		}
		return out
	}
	info.Title = trim(info.Title)
	info.Album = trim(info.Album)
	info.Comment = trim(info.Comment)
	info.Lyrics = trim(info.Lyrics)
	info.Artists = values(info.Artists)
	info.AlbumArtists = values(info.AlbumArtists)
	info.Container = trim(info.Container)
	info.Codec = trim(info.Codec)
	info.Pictures = nil
	info.PicturesLoaded = false
	return info
}
