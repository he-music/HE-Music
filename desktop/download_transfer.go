package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"sync"

	"github.com/he-music/HE-Music/desktop/metadata"
)

// A transfer owns its progress and failure stage until all private files and
// response resources are cleaned up. The coordinator only publishes job state.
type downloadTransfer struct {
	coordinator *downloadCoordinator
	job         *downloadJob
	out         *DownloadState
	stage       string
	status      int
}

func downloadWorkTarget(root *os.Root, target string) (*os.Root, string, os.FileInfo, error) {
	workRoot, name, err := downloadNativeOpenTarget(root, target)
	if err != nil {
		return nil, "", nil, err
	}
	info, err := workRoot.Stat(".")
	if err != nil {
		if workRoot != root {
			_ = workRoot.Close()
		}
		return nil, "", nil, err
	}
	return workRoot, name, info, nil
}

func (t *downloadTransfer) cleanupPrivate(owned []*downloadOwnedPrivate, target string) {
	for _, private := range owned {
		if err := private.cleanup(); err != nil {
			t.out.Code = "cleanup_failed"
			logDownloadFailure("cleanup_private", t.status, err, *t.out)
			if private.residual {
				t.out.ResidualName = path.Join(path.Dir(target), private.name)
			}
		}
	}
	if t.job.ctx.Err() != nil {
		t.out.Code = "cancelled"
		if errors.Is(t.job.ctx.Err(), context.DeadlineExceeded) {
			t.out.Code = "timeout"
		}
		t.out.Ref = nil
	}
}

func (t *downloadTransfer) request(rawURL string) (*http.Response, func(), error) {
	req, err := http.NewRequestWithContext(t.job.ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		t.out.Code = "invalid_request"
		return nil, nil, err
	}
	req.Header.Set("Accept-Encoding", "identity")
	t.stage = "fetch_audio"
	resp, err := t.coordinator.client.Do(req)
	if err != nil {
		t.out.Code = "network_error"
		return nil, nil, err
	}
	var once sync.Once
	var closeErr error
	closeBody := func() { once.Do(func() { closeErr = resp.Body.Close() }) }
	stop := context.AfterFunc(t.job.ctx, closeBody)
	cleanup := func() {
		stop()
		closeBody()
		if closeErr != nil && (t.out.Code == "ok" || t.out.Code == "durability_uncertain") {
			t.out.Code = "cleanup_failed"
			logDownloadFailure("close_response", t.status, closeErr, *t.out)
			if !t.out.Committed {
				t.out.Ref = nil
			}
		}
	}
	t.status = resp.StatusCode
	return resp, cleanup, nil
}

func (t *downloadTransfer) receive(resp *http.Response, file *os.File) error {
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Range") != "" || resp.Uncompressed || (resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") {
		t.out.Code = "http_rejected"
		return errDownload
	}
	if resp.ContentLength > 0 {
		t.out.Total = resp.ContentLength
	}
	c, j := t.coordinator, t.job
	c.mu.Lock()
	j.state.Total = t.out.Total
	c.mu.Unlock()
	t.stage = "read_audio"
	buf := make([]byte, 32<<10)
	for {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			written, err := file.Write(buf[:n])
			t.out.Received += int64(written)
			c.mu.Lock()
			j.state.Received = t.out.Received
			c.mu.Unlock()
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			t.out.Code = "network_error"
			return readErr
		}
		if n == 0 {
			t.out.Code = "network_error"
			return io.ErrNoProgress
		}
	}
	if resp.ContentLength >= 0 && t.out.Received != resp.ContentLength {
		t.out.Code = "http_rejected"
		return errDownload
	}
	return nil
}

func (t *downloadTransfer) validateAudio(file *os.File, target string) error {
	t.stage = "parse_audio"
	reader := metadataReader{ctx: t.job.ctx, file: file}
	info, err := metadata.ParseScan(reader, t.out.Received)
	if err != nil {
		t.out.Code = "payload_rejected"
		return err
	}
	if !localAudioContainerMatches(info.Container, path.Base(target)) {
		t.out.Code = "unsupported"
		return errDownload
	}
	// Discard parsed tags: cached results contain no pictures or unbounded strings.
	t.stage = "validate_audio"
	if err := metadata.CompareAudioPayload(t.job.ctx, reader, t.out.Received, reader, t.out.Received); err != nil {
		t.out.Code = "payload_rejected"
		return err
	}
	return nil
}

func (t *downloadTransfer) editAudio(root *os.Root, work *downloadOwnedPrivate, owned *[]*downloadOwnedPrivate) error {
	t.stage = "copy_source"
	j := t.job
	source, err := downloadNewPrivate(root, "source", j.io)
	if source != nil {
		*owned = append(*owned, source)
	}
	if err != nil {
		return err
	}
	if err := j.io.before("source", "copy"); err != nil {
		return err
	}
	if err := j.io.before("source", "write"); err != nil {
		return err
	}
	if _, err := io.Copy(source.file, io.NewSectionReader(work.file, 0, t.out.Received)); err != nil {
		return err
	}
	if err := source.sync(); err != nil {
		return err
	}
	original, err := source.file.Stat()
	if err != nil {
		return err
	}
	t.stage = "edit_metadata"
	if err := downloadNativeMetadata(j.ctx, t.coordinator.client, root, work.file, work.name, j.options); err != nil {
		t.out.Code = "unsupported"
		return err
	}
	t.stage = "verify_metadata"
	edited, editErr := work.file.Stat()
	current, sourceErr := source.file.Stat()
	if editErr != nil || sourceErr != nil || !os.SameFile(current, original) {
		t.out.Code = "payload_rejected"
		return errors.Join(editErr, sourceErr, errDownload)
	}
	if err := metadata.CompareAudioPayload(j.ctx, source.file, original.Size(), work.file, edited.Size()); err != nil {
		t.out.Code = "payload_rejected"
		return err
	}
	return nil
}

func (t *downloadTransfer) verifyTargetParent(target string, expected os.FileInfo) error {
	if err := downloadNativeVerifyRoute(t.job.lease.handle.root, target); err != nil {
		t.out.Code = "conflict"
		return err
	}
	current, err := downloadNativeParentInfo(t.job.lease.handle.root, target)
	if err != nil || !os.SameFile(expected, current) {
		t.out.Code = "conflict"
		return errors.Join(err, errFilesChanged)
	}
	return nil
}

func (t *downloadTransfer) authorize(s *nativeFilesState, target string, parent os.FileInfo) error {
	t.stage = "authorize_commit"
	if err := t.job.io.before("commit", "before_claim"); err != nil {
		return err
	}
	if err := t.verifyTargetParent(target, parent); err != nil {
		return err
	}
	if err := s.claimDownloadCommit(t.job); err != nil {
		t.out.Code = "revoked"
		return err
	}
	if err := t.job.io.before("commit", "after_claim"); err != nil {
		return err
	}
	return t.verifyTargetParent(target, parent)
}

func (t *downloadTransfer) publishAudio(root *os.Root, name string, work *downloadOwnedPrivate) (os.FileInfo, error) {
	t.stage = "publish_audio"
	if err := work.publish(name); err != nil {
		t.out.Code = "atomic_commit_failed"
		if errors.Is(err, os.ErrExist) {
			t.out.Code = "conflict"
		}
		return nil, err
	}
	t.out.Committed = true
	c, j := t.coordinator, t.job
	c.mu.Lock()
	j.state.Committed = true
	c.mu.Unlock()
	if err := j.io.before("commit", "after_audio"); err != nil {
		t.out.Code = "partial_committed"
		return nil, err
	}
	// Never delete or roll back the published name after this point.
	published, err := root.Lstat(name)
	original, statErr := work.file.Stat()
	if err != nil || statErr != nil || !sameLocalFileInfo(published, original) {
		t.out.Code = "conflict"
		return nil, errors.Join(err, statErr, errFilesChanged)
	}
	return original, nil
}

func (t *downloadTransfer) registerAudio(s *nativeFilesState, target string, parent, original os.FileInfo) error {
	t.stage = "register_audio"
	ref, registered, err := s.registerLocalFile(t.job.lease, target)
	if err != nil {
		t.out.Code = "registration_failed"
		return err
	}
	info, statErr := registered.Stat()
	closeErr := registered.Close()
	if statErr != nil || closeErr != nil || !sameLocalFileInfo(original, info) {
		t.out.Code = "conflict"
		return errors.Join(statErr, closeErr, errFilesChanged)
	}
	current, err := downloadNativeParentInfo(t.job.lease.handle.root, target)
	if err != nil || !os.SameFile(parent, current) {
		t.out.Code = "registration_failed"
		return errors.Join(err, errFilesChanged)
	}
	t.out.Ref = ref
	return nil
}

func (t *downloadTransfer) publishSidecars(root *os.Root, sidecars []downloadStagedSidecar) error {
	t.stage = "publish_sidecars"
	for _, sidecar := range sidecars {
		err := t.job.io.before("sidecar", "publish")
		if err == nil {
			err = sidecar.private.publish(sidecar.public)
		}
		if err != nil {
			t.out.Code = "partial_committed"
			return err
		}
	}
	if err := t.job.io.before("commit", "after_sidecars"); err != nil {
		t.out.Code = "partial_committed"
		return err
	}
	t.stage = "sync_directory"
	durability := t.job.io.DirectoryDurability
	if durability == nil {
		durability = downloadCommitDirectoryDurability
	}
	durable, err := durability(root)
	if err != nil {
		t.out.Code = "sync_failed"
		return err
	}
	if durable {
		t.out.Code = "ok"
	} else {
		t.out.Code = "durability_uncertain"
	}
	return nil
}
