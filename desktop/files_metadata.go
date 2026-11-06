package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"reflect"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/metadata"
	"github.com/he-music/HE-Music/desktop/metadatadigest"
)

const (
	metadataPrivatePrefix       = ".hemusic-metadata-"
	metadataMaxJobs             = 256
	metadataMaxActive           = 2
	metadataCacheBytes    int64 = 64 << 20
	metadataJobBaseBytes  int64 = 16 << 10
)

// Native playback installs this hook to drain its gateway readers before writes.
// Browser file playback continues to stop in the frontend before saving.
var beforeLocalFileMutation func(context.Context, *NativeFiles, os.FileInfo) (release func(), err error)

// MetadataResult never transports OS errors or machine paths. SHA256 is the
// complete source baseline required by SaveMetadata, not a stat fingerprint.
type MetadataResult struct {
	Code   string         `json:"code"`
	Ref    *LocalFileRef  `json:"ref,omitempty"`
	Info   *metadata.Info `json:"info,omitempty"`
	SHA256 string         `json:"sha256,omitempty"`
	// MD5 is only the legacy online-match key, never an authorization baseline.
	MD5           string   `json:"md5,omitempty"`
	ResidualNames []string `json:"residualNames,omitempty"`
	RecoveryName  string   `json:"recoveryName,omitempty"`
	Committed     bool     `json:"committed"`
}

type MetadataSaveRequest struct {
	OperationID string         `json:"operationId"`
	Ref         LocalFileRef   `json:"ref"`
	SHA256      string         `json:"sha256"`
	Patch       metadata.Patch `json:"patch"`
}

type metadataJob struct {
	owner         context.Context
	epoch         uint64
	ref           LocalFileRef
	cancel        context.CancelFunc
	done          chan struct{}
	result        MetadataResult
	context       context.Context
	active        bool
	finished      bool
	retired       bool
	bytes         int64
	stopGrant     func() bool
	stopOwner     func() bool
	stopOperation func() bool
}
type metadataSlot struct {
	info os.FileInfo
	done chan struct{}
}
type metadataCoordinator struct {
	mu          sync.Mutex
	jobs        map[string]*metadataJob
	slots       []*metadataSlot
	owner       context.Context
	epoch       uint64
	active      int
	cachedBytes int64
	resultBytes int64
}

var metadataCoordinators = struct {
	sync.Mutex
	entries map[*nativeFilesState]*metadataCoordinator
}{entries: make(map[*nativeFilesState]*metadataCoordinator)}

func metadataCoordinatorFor(s *nativeFilesState) *metadataCoordinator {
	metadataCoordinators.Lock()
	defer metadataCoordinators.Unlock()
	c := metadataCoordinators.entries[s]
	if c == nil {
		c = &metadataCoordinator{jobs: make(map[string]*metadataJob)}
		metadataCoordinators.entries[s] = c
	}
	return c
}

func (c *metadataCoordinator) lock(ctx context.Context, info os.FileInfo) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		var wait chan struct{}
		for _, slot := range c.slots {
			if os.SameFile(slot.info, info) {
				wait = slot.done
				break
			}
		}
		if wait == nil {
			slot := &metadataSlot{info: info, done: make(chan struct{})}
			c.slots = append(c.slots, slot)
			c.mu.Unlock()
			return func() {
				c.mu.Lock()
				defer c.mu.Unlock()
				for i, s := range c.slots {
					if s == slot {
						c.slots = append(c.slots[:i], c.slots[i+1:]...)
						close(slot.done)
						break
					}
				}
			}, nil
		}
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait:
		}
	}
}

func metadataCode(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, errFilesOwner), errors.Is(err, errFilesLease), errors.Is(err, errFilesToken):
		return "revoked"
	case errors.Is(err, errMetadataLimit), errors.Is(err, metadatadigest.ErrEmpty):
		return "limit"
	case errors.Is(err, errMetadataOperation):
		return "invalid_operation"
	case errors.Is(err, errFilesChanged), errors.Is(err, metadatadigest.ErrChanged):
		return "conflict"
	case errors.Is(err, metadata.ErrUnsupportedContainer), errors.Is(err, metadata.ErrUnsupportedPayload):
		return "unsupported"
	case errors.Is(err, metadata.ErrAudioPayloadChanged), errors.Is(err, metadata.ErrInvalidPayload):
		return "payload_rejected"
	default:
		return "io_error"
	}
}

func metadataHash(ctx context.Context, f *os.File) (string, error) {
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() <= 0 {
		return "", errMetadataLimit
	}
	h := sha256.New()
	buf := make([]byte, 32<<10)
	for off := int64(0); off < info.Size(); {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n := min(int64(len(buf)), info.Size()-off)
		read, err := f.ReadAt(buf[:n], off)
		if read != int(n) {
			return "", io.ErrUnexpectedEOF
		}
		if err != nil && err != io.EOF {
			return "", err
		}
		h.Write(buf[:n])
		off += n
	}
	after, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !sameLocalFileInfo(info, after) {
		return "", errFilesChanged
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

var (
	errMetadataLimit     = errors.New("metadata size limit")
	errMetadataOperation = errors.New("metadata operation ID belongs to a different reference")
)

func (f *NativeFiles) ReadMetadata(ctx context.Context, epoch uint64, ref LocalFileRef) MetadataResult {
	lease, err := f.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer lease.Release()
	op, cancel := context.WithCancel(lease.Context())
	defer cancel()
	source, err := f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	info, err := source.Stat()
	source.Close()
	if err != nil {
		return MetadataResult{Code: "io_error"}
	}
	unlock, err := metadataCoordinatorFor(&f.state).lock(op, info)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer unlock()
	source, err = f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer source.Close()
	digests, err := metadatadigest.Source(op, source)
	if err != nil {
		if errors.Is(err, errMetadataLimit) {
			return MetadataResult{Code: "limit"}
		}
		return MetadataResult{Code: metadataCode(err)}
	}
	parsed, err := metadata.Parse(metadataReader{op, source}, info.Size())
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	// Reopen the reference after parsing to detect path/parent replacement as well
	// as in-place content changes (including unchanged size and mtime).
	current, err := f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer current.Close()
	final, err := metadataHash(op, current)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	if final != digests.SHA256 {
		return MetadataResult{Code: "conflict"}
	}
	if err = f.state.checkLease(lease); err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	if err = op.Err(); err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	return MetadataResult{Code: "ok", Ref: &ref, Info: &parsed, SHA256: digests.SHA256, MD5: digests.MD5}
}

// OperationID is a caller-generated 32-byte hex nonce. Reusing it never writes
// twice; completed operations return their original result while still owned.
func (f *NativeFiles) SaveMetadata(ctx context.Context, epoch uint64, req MetadataSaveRequest) MetadataResult {
	if b, err := decodeDirectoryToken(req.OperationID); err != nil || len(b) != 32 {
		return MetadataResult{Code: "invalid_operation"}
	}
	if b, err := hex.DecodeString(req.SHA256); err != nil || len(b) != 32 {
		return MetadataResult{Code: "invalid_baseline"}
	}
	if len(req.Ref.RelativePath) > 4096 || len(req.Ref.FileID) > 64 || len(req.Ref.Version) > 64 || !metadataPatchWithinLimit(req.Patch) {
		return MetadataResult{Code: "limit"}
	}
	lease, err := f.state.acquireDirectory(ctx, epoch, req.Ref.GrantToken)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	defer lease.Release()
	c := metadataCoordinatorFor(&f.state)
	job, fresh, err := c.register(&f.state, lease, req)
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	if !fresh {
		select {
		case <-lease.Context().Done():
			return MetadataResult{Code: "revoked"}
		case <-job.done:
		}
		return c.completed(&f.state, lease, req.OperationID, job)
	}
	// Only this worker owns the operation context until finish. Watchers can
	// cancel it, but cannot drop active IO permits or publish a retired result.
	c.mu.Lock()
	op, cancel := job.context, job.cancel
	c.mu.Unlock()
	defer cancel()
	result := f.saveMetadata(op, lease, c, job, req)
	if err := op.Err(); err != nil {
		result = metadataWithoutContent(result, metadataCode(err))
	}
	return c.finish(&f.state, lease, req.OperationID, job, result)
}

func (f *NativeFiles) CancelMetadata(ctx context.Context, epoch uint64, id string) MetadataResult {
	c := metadataCoordinatorFor(&f.state)
	err := f.state.main(ctx, func(_ *mygo.Window) error {
		if !f.state.owns(ctx, epoch) {
			return errFilesOwner
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		job := c.jobs[id]
		if job == nil || job.owner != ctx || job.epoch != epoch || job.retired {
			return errMetadataOperation
		}
		if job.cancel != nil {
			job.cancel()
			c.releaseReservationLocked(job)
		}
		return nil
	})
	return MetadataResult{Code: metadataCode(err)}
}

func metadataPatchMatches(info metadata.Info, patch metadata.Patch) bool {
	return (patch.Title == nil || info.Title == *patch.Title) &&
		(patch.Album == nil || info.Album == *patch.Album) &&
		(patch.Comment == nil || info.Comment == *patch.Comment) &&
		(patch.Lyrics == nil || info.Lyrics == *patch.Lyrics) &&
		(patch.Artists == nil || slices.Equal(info.Artists, *patch.Artists)) &&
		(patch.AlbumArtists == nil || slices.Equal(info.AlbumArtists, *patch.AlbumArtists)) &&
		(patch.Pictures == nil || len(info.Pictures) == 0 && len(*patch.Pictures) == 0 ||
			reflect.DeepEqual(info.Pictures, *patch.Pictures))
}

func (f *NativeFiles) saveMetadata(ctx context.Context, lease *directoryLease, c *metadataCoordinator, job *metadataJob, req MetadataSaveRequest) (out MetadataResult) {
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	fail := func(err error) MetadataResult {
		if errors.Is(err, errMetadataLimit) {
			return MetadataResult{Code: "limit"}
		}
		return MetadataResult{Code: metadataCode(err)}
	}
	source, original, unlock, code := f.openMetadataSaveSource(ctx, lease, c, req)
	if code != "" {
		return MetadataResult{Code: code}
	}
	defer unlock()
	defer source.Close()
	baseline := req.SHA256
	parent, err := lease.handle.root.OpenRoot(path.Dir(req.Ref.RelativePath))
	if err != nil {
		return fail(err)
	}
	defer parent.Close()
	pinned, err := parent.Stat(".")
	if err != nil {
		return fail(err)
	}
	work, workName, err := metadataTemp(parent, "work")
	if err != nil {
		return fail(err)
	}
	defer work.Close()
	defer metadataRemoveTemporary(parent, workName, path.Dir(req.Ref.RelativePath), &out)
	parsed, code := prepareMetadataEdit(ctx, source, work, original.Size(), baseline, req.Patch)
	if code != "" {
		return MetadataResult{Code: code}
	}
	if err = c.reserve(&f.state, lease, job, parsed); err != nil {
		return fail(err)
	}
	// A backup is an independent complete copy. The original is never renamed
	// away first, so a failed replacement requires no potentially destructive undo.
	backup, backupName, err := metadataTemp(parent, "backup")
	if err != nil {
		return fail(err)
	}
	keepBackup := false
	defer func() {
		backup.Close()
		if !keepBackup {
			metadataRemoveTemporary(parent, backupName, path.Dir(req.Ref.RelativePath), &out)
		}
	}()
	if code := prepareMetadataBackup(ctx, source, backup, work, original.Size(), baseline, parent); code != "" {
		return MetadataResult{Code: code}
	}
	release, code = f.prepareLocalFileMutation(ctx, original)
	if code != "" {
		return MetadataResult{Code: code}
	}
	// Reopen from the authorized route immediately before claim. os.Root pins IO
	// but cannot supply a cross-process compare-and-swap between check and Rename.
	if code := f.checkMetadataSaveRoute(ctx, lease, req.Ref, original, pinned, baseline); code != "" {
		return MetadataResult{Code: code}
	}
	if err = ctx.Err(); err != nil {
		return fail(err)
	}
	commit := newFileCommit()
	// Cancellation and actor claim race under the commit mutex, matching revoke's
	// claim-before/revoke-before contract. A claimed rename may finish after cancel.
	stop := context.AfterFunc(ctx, func() { f.state.invalidateFileCommit(commit) })
	defer stop()
	if err = f.state.claimFileCommit(lease, commit); err != nil {
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		return fail(err)
	}
	defer f.state.finishFileCommit(commit)
	if err = ctx.Err(); err != nil {
		return fail(err)
	}
	keepBackup = true
	recovery := path.Join(path.Dir(req.Ref.RelativePath), backupName)
	if err = parent.Rename(workName, path.Base(req.Ref.RelativePath)); err != nil {
		return MetadataResult{Code: "replace_failed", RecoveryName: recovery}
	}
	invalidateLibraryMetadata(lease.handle.canonical, req.Ref.RelativePath)
	out, keepBackup = f.publishMetadataResult(lease, work, parent, backupName, original, parsed, req.Ref.RelativePath)
	return out
}

func metadataTemp(root *os.Root, kind string) (*os.File, string, error) {
	token, err := newDirectoryToken()
	if err != nil {
		return nil, "", err
	}
	name := metadataPrivatePrefix + kind + "-" + token
	file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	return file, name, err
}

func metadataCopy(ctx context.Context, dst, src *os.File, size int64) error {
	if size <= 0 {
		return errMetadataLimit
	}
	buf := make([]byte, 32<<10)
	for off := int64(0); off < size; {
		if err := ctx.Err(); err != nil {
			return err
		}
		n := min(int64(len(buf)), size-off)
		read, err := src.ReadAt(buf[:n], off)
		if read != int(n) {
			return io.ErrUnexpectedEOF
		}
		if err != nil && err != io.EOF {
			return err
		}
		written, err := dst.WriteAt(buf[:n], off)
		if err != nil {
			return err
		}
		if written != int(n) {
			return io.ErrShortWrite
		}
		off += n
	}
	return nil
}

// Cleanup failures expose only grant-relative names. Work names are unvalidated
// artifacts; only backup names produced after validation contain recovery bytes.
func metadataRemoveTemporary(root *os.Root, name, parent string, result *MetadataResult) {
	if err := root.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		result.ResidualNames = append(result.ResidualNames, path.Join(parent, name))
		if result.Code == "ok" {
			result.Code = "saved_cleanup_required"
		}
	}
}

// An unsupported directory durability guarantee remains distinct from an I/O error.
var metadataDirectoryDurability = metadataCommitDirectoryDurability

// Bound both adapter work and tag expansion independently of the input file.
func metadataPatchWithinLimit(p metadata.Patch) bool {
	total := 0
	for _, v := range []*string{p.Title, p.Album, p.Comment, p.Lyrics} {
		if v != nil {
			total += len(*v)
			if total > 8<<20 {
				return false
			}
		}
	}
	for _, v := range []*[]string{p.Artists, p.AlbumArtists} {
		if v != nil {
			if len(*v) > 128 {
				return false
			}
			for _, s := range *v {
				total += len(s)
				if total > 8<<20 {
					return false
				}
			}
		}
	}
	if p.Pictures != nil {
		if len(*p.Pictures) > 16 {
			return false
		}
		for _, v := range *p.Pictures {
			total += len(v.Data) + len(v.MIME) + len(v.Description)
			if total > 8<<20 {
				return false
			}
		}
	}
	return true
}

type metadataReader struct {
	ctx  context.Context
	file *os.File
}

func (r metadataReader) ReadAt(p []byte, off int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.file.ReadAt(p, off)
	if cancelled := r.ctx.Err(); cancelled != nil {
		return n, cancelled
	}
	return n, err
}

// register runs actor -> coordinator only. Session validation and registry
// advancement share the actor turn; a lease captured by an old epoch cannot
// retire a newer epoch's records. IO identity slots and active permits survive
// registry retirement until the workers actually finish.
func (c *metadataCoordinator) register(s *nativeFilesState, lease *directoryLease, req MetadataSaveRequest) (*metadataJob, bool, error) {
	var job *metadataJob
	var fresh bool
	id := req.OperationID
	err := s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.owner != lease.owner || c.epoch != lease.epoch {
			for id, old := range c.jobs {
				c.retireLocked(id, old)
			}
			c.owner, c.epoch = lease.owner, lease.epoch
		}
		if previous := c.jobs[req.OperationID]; previous != nil {
			if previous.ref != req.Ref {
				return errMetadataOperation
			}
			job = previous
			return nil
		}
		if len(c.jobs) >= metadataMaxJobs {
			return errMetadataLimit
		}
		op, cancel := context.WithCancel(lease.Context())
		job = &metadataJob{
			owner: lease.owner, epoch: lease.epoch, ref: req.Ref, context: op,
			cancel: cancel, done: make(chan struct{}), bytes: metadataJobBaseBytes,
		}
		c.jobs[req.OperationID] = job
		c.cachedBytes += job.bytes
		retire := func() { c.mu.Lock(); defer c.mu.Unlock(); c.retireLocked(id, job) }
		// Never watch lease.Context for completed-result lifetime: normal Release
		// cancels that context too. Grant and owner contexts outlive individual calls.
		job.stopGrant = context.AfterFunc(lease.handle.leaseContext, retire)
		job.stopOwner = context.AfterFunc(lease.owner, retire)
		if c.active >= metadataMaxActive {
			job.result = MetadataResult{Code: "limit"}
			job.finished = true
			job.context, job.cancel = nil, nil
			close(job.done)
			cancel()
			return nil
		}
		c.active++
		job.active = true
		job.stopOperation = context.AfterFunc(op, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if !job.finished {
				c.releaseReservationLocked(job)
			}
		})
		fresh = true
		return nil
	})
	return job, fresh, err
}

func (c *metadataCoordinator) releaseReservationLocked(job *metadataJob) {
	if job.bytes > metadataJobBaseBytes {
		extra := job.bytes - metadataJobBaseBytes
		c.cachedBytes -= extra
		c.resultBytes -= extra
		job.bytes = metadataJobBaseBytes
	}
}

func (c *metadataCoordinator) retireLocked(id string, job *metadataJob) {
	if job.retired {
		return
	}
	job.retired = true
	c.releaseReservationLocked(job)
	if c.jobs[id] == job {
		delete(c.jobs, id)
		c.cachedBytes -= job.bytes
	}
	job.bytes = 0
	job.result = MetadataResult{}
	job.ref = LocalFileRef{}
	job.owner = nil
	if job.cancel != nil {
		job.cancel()
	}
	if job.stopGrant != nil {
		job.stopGrant()
		job.stopGrant = nil
	}
	if job.stopOwner != nil {
		job.stopOwner()
		job.stopOwner = nil
	}
	// Do not touch slots, active or done: the old worker still owns its IO.
	if len(c.jobs) == 0 {
		c.owner = nil
		c.epoch = 0
	}
}

// Every possible job has a prepaid lightweight tombstone allowance. Heavy
// results cannot consume it, so budget rejection never needs to evict an ID.
func (c *metadataCoordinator) reserve(s *nativeFilesState, lease *directoryLease, job *metadataJob, info metadata.Info) error {
	bytes := metadataInfoBytes(info)
	return s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if job.retired {
			return errFilesLease
		}
		if err := job.context.Err(); err != nil {
			return err
		}
		if bytes > metadataCacheBytes-metadataMaxJobs*metadataJobBaseBytes-c.resultBytes {
			return errMetadataLimit
		}
		job.bytes += bytes
		c.resultBytes += bytes
		c.cachedBytes += bytes
		return nil
	})
}

func metadataInfoBytes(info metadata.Info) int64 {
	// Conservative backing-array accounting (including capacity), not just image
	// lengths. The per-job allowance covers result/ref/string headers and watches.
	bytes := int64(512 + len(info.Container) + len(info.Title) + len(info.Album) + len(info.Comment) + len(info.Lyrics) + len(info.Codec))
	bytes += int64(cap(info.Artists)+cap(info.AlbumArtists)) * 32
	for _, value := range info.Artists {
		bytes += int64(len(value))
	}
	for _, value := range info.AlbumArtists {
		bytes += int64(len(value))
	}
	bytes += int64(cap(info.Pictures)) * 128
	for _, picture := range info.Pictures {
		bytes += int64(cap(picture.Data) + len(picture.MIME) + len(picture.Description))
	}
	return bytes
}

func metadataWithoutContent(result MetadataResult, code string) MetadataResult {
	return MetadataResult{Code: code, Committed: result.Committed, RecoveryName: result.RecoveryName, ResidualNames: result.ResidualNames}
}

func (c *metadataCoordinator) finishLocked(id string, job *metadataJob, result MetadataResult) MetadataResult {
	if job.context != nil && job.context.Err() != nil {
		result = metadataWithoutContent(result, metadataCode(job.context.Err()))
	}
	if job.active {
		c.active--
		job.active = false
	}
	if job.retired || c.jobs[id] != job {
		result = metadataWithoutContent(result, "revoked")
	} else {
		if result.Info == nil {
			c.releaseReservationLocked(job)
		}
		job.result = result
	}
	job.finished = true
	if job.stopOperation != nil {
		job.stopOperation()
		job.stopOperation = nil
	}
	job.context, job.cancel = nil, nil
	close(job.done)
	return result
}

func (c *metadataCoordinator) finish(s *nativeFilesState, lease *directoryLease, id string, job *metadataJob, result MetadataResult) MetadataResult {
	err := s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		result = c.finishLocked(id, job, result)
		return nil
	})
	if err != nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		result = c.finishLocked(id, job, metadataWithoutContent(result, metadataCode(err)))
	}
	return result
}

func (c *metadataCoordinator) completed(s *nativeFilesState, lease *directoryLease, id string, job *metadataJob) MetadataResult {
	var result MetadataResult
	err := s.main(lease.owner, func(parent *mygo.Window) error {
		if err := s.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if job.retired || c.jobs[id] != job {
			return errFilesLease
		}
		result = job.result
		return nil
	})
	if err != nil {
		return MetadataResult{Code: metadataCode(err)}
	}
	return result
}

// Cache only detached values: a short string or image view must not keep an
// unaccounted parser buffer alive. Slice capacities below are then measurable.
func metadataDetachInfo(info metadata.Info) metadata.Info {
	info.Container = strings.Clone(info.Container)
	info.Title = strings.Clone(info.Title)
	info.Album = strings.Clone(info.Album)
	info.Comment = strings.Clone(info.Comment)
	info.Lyrics = strings.Clone(info.Lyrics)
	info.Codec = strings.Clone(info.Codec)
	info.Artists = slices.Clone(info.Artists)
	for i, value := range info.Artists {
		info.Artists[i] = strings.Clone(value)
	}
	info.AlbumArtists = slices.Clone(info.AlbumArtists)
	for i, value := range info.AlbumArtists {
		info.AlbumArtists[i] = strings.Clone(value)
	}
	info.Pictures = slices.Clone(info.Pictures)
	for i, picture := range info.Pictures {
		info.Pictures[i].MIME = strings.Clone(picture.MIME)
		info.Pictures[i].Description = strings.Clone(picture.Description)
		info.Pictures[i].Data = slices.Clone(picture.Data)
	}
	return info
}
