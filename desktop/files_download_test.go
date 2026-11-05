package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/metadata"
)

type downloadRoundTripper func(*http.Request) (*http.Response, error)

func (f downloadRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func downloadMP3() []byte {
	frame := make([]byte, 417)
	copy(frame, []byte{255, 251, 144, 0})
	return bytes.Repeat(frame, 2)
}

func downloadCRC(data []byte, width uint, poly uint32) uint32 {
	var crc uint32
	for _, b := range data {
		crc ^= uint32(b) << (width - 8)
		for range 8 {
			if crc&(1<<(width-1)) != 0 {
				crc = crc<<1 ^ poly
			} else {
				crc <<= 1
			}
		}
	}
	return crc & ((1 << width) - 1)
}

func downloadFLAC() []byte {
	info := make([]byte, 34)
	binary.BigEndian.PutUint16(info[:2], 16)
	binary.BigEndian.PutUint16(info[2:4], 16)
	binary.BigEndian.PutUint64(info[10:18], uint64(44100)<<44|uint64(15)<<36|16)
	frame := []byte{255, 248, 105, 8, 0, 15}
	frame = append(frame, byte(downloadCRC(frame, 8, 7)))
	frame = append(frame, 0, 0, 0)
	crc := downloadCRC(frame, 16, 0x8005)
	frame = append(frame, byte(crc>>8), byte(crc))
	return append(append([]byte("fLaC\x80\x00\x00\x22"), info...), frame...)
}

func downloadFixture(t *testing.T) (*fileTestActor, context.Context, uint64, *downloadCoordinator, string, string) {
	t.Helper()
	a, ctx, epoch, lease, dir := grantedLeaseFixture(t)
	token := lease.token
	lease.Release()
	c := downloadCoordinatorFor(a.state)
	t.Cleanup(func() {
		c.mu.Lock()
		jobs := make([]*downloadJob, 0, len(c.jobs))
		for _, j := range c.jobs {
			c.retireLocked(j)
			jobs = append(jobs, j)
		}
		c.mu.Unlock()
		for _, j := range jobs {
			select {
			case <-j.done:
			case <-time.After(3 * time.Second):
				t.Error("worker cleanup timed out")
			}
		}
		downloadCoordinators.Lock()
		delete(downloadCoordinators.entries, a.state)
		downloadCoordinators.Unlock()
	})
	return a, ctx, epoch, c, token, dir
}

func downloadReq(t *testing.T, token, filename string) DownloadRequest {
	t.Helper()
	id, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	return DownloadRequest{OperationID: id, GrantToken: token, URL: "https://audio.invalid/audio?secret=never-return", Filename: filename}
}

func downloadStart(t *testing.T, a *fileTestActor, ctx context.Context, epoch uint64, c *downloadCoordinator, req DownloadRequest) *downloadJob {
	t.Helper()
	if _, err := a.state.startDownload(ctx, epoch, req); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	j := c.jobs[req.OperationID]
	c.mu.Unlock()
	return j
}

func downloadWait(t *testing.T, j *downloadJob) {
	t.Helper()
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("download did not clean up")
	}
}

func downloadResponse(data []byte, total int64) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data)), ContentLength: total}
}

func assertDownloadClean(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), downloadPrivatePrefix) {
			t.Errorf("temporary file leaked: %s", e.Name())
		}
	}
}

func TestDownloadSuccessPayloadAndIdempotency(t *testing.T) {
	for _, format := range []string{"mp3", "flac"} {
		t.Run(format, func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			data := downloadMP3()
			if format == "flac" {
				data = downloadFLAC()
			}
			var calls atomic.Int32
			c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.Header.Get("Accept-Encoding") != "identity" || r.Header.Get("Authorization") != "" {
					t.Error("unexpected request headers")
				}
				return downloadResponse(data, int64(len(data))), nil
			})
			req := downloadReq(t, token, "audio."+format)
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
			if err != nil || !state.Done || !state.Committed || state.Code != "ok" || state.Ref == nil || state.Received != int64(len(data)) {
				t.Fatalf("state=%+v err=%v", state, err)
			}
			saved, err := os.ReadFile(filepath.Join(dir, req.Filename))
			if err != nil {
				t.Fatal(err)
			}
			if sha256.Sum256(saved) != sha256.Sum256(data) {
				t.Fatal("whole-file hash changed")
			}
			if err := metadata.CompareAudioPayload(ctx, bytes.NewReader(data), int64(len(data)), bytes.NewReader(saved), int64(len(saved))); err != nil {
				t.Fatal(err)
			}
			if _, err := a.state.startDownload(ctx, epoch, req); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatal("same ID downloaded twice")
			}
			if _, err := c.access(a.state, ctx, epoch+1, req.OperationID, false); err == nil {
				t.Fatal("stale epoch read")
			}
			req.URL += "changed"
			if _, err := a.state.startDownload(ctx, epoch, req); err == nil {
				t.Fatal("different request reused ID")
			}
			c.mu.Lock()
			active := c.active
			c.mu.Unlock()
			if active != 0 || !j.lease.released.Load() {
				t.Fatal("done preceded permit/lease release")
			}
			assertDownloadClean(t, dir)
		})
	}
}

func TestDownloadConflictAndSameNameCompetition(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "competition", true: "existing"}[existing], func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			data := downloadMP3()
			old := []byte("do not overwrite")
			if existing {
				if err := os.WriteFile(filepath.Join(dir, "same.mp3"), old, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			barrier := make(chan struct{})
			entered := make(chan struct{}, 2)
			c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
				entered <- struct{}{}
				<-barrier
				return downloadResponse(data, -1), nil
			})
			j1 := downloadStart(t, a, ctx, epoch, c, downloadReq(t, token, "same.mp3"))
			j2 := downloadStart(t, a, ctx, epoch, c, downloadReq(t, token, "same.mp3"))
			<-entered
			<-entered
			close(barrier)
			downloadWait(t, j1)
			downloadWait(t, j2)
			c.mu.Lock()
			s1, s2 := j1.state, j2.state
			c.mu.Unlock()
			successes := 0
			for _, s := range []DownloadState{s1, s2} {
				if s.Code == "ok" {
					successes++
				} else if s.Code != "conflict" || s.Committed {
					t.Fatalf("unexpected conflict: %+v", s)
				}
			}
			want := 1
			if existing {
				want = 0
			}
			if successes != want {
				t.Fatalf("successes=%d", successes)
			}
			saved, err := os.ReadFile(filepath.Join(dir, "same.mp3"))
			if err != nil {
				t.Fatal(err)
			}
			expected := data
			if existing {
				expected = old
			}
			if !bytes.Equal(saved, expected) {
				t.Fatal("target overwritten")
			}
			assertDownloadClean(t, dir)
		})
	}
}

func TestDownloadHTTPAndPayloadHardGates(t *testing.T) {
	cases := []struct {
		name     string
		response func() *http.Response
		code     string
	}{
		{"partial", func() *http.Response { r := downloadResponse(downloadMP3(), -1); r.StatusCode = 206; return r }, "http_rejected"},
		{"range", func() *http.Response {
			r := downloadResponse(downloadMP3(), -1)
			r.Header.Set("Content-Range", "bytes 0-833/834")
			return r
		}, "http_rejected"},
		{"truncated", func() *http.Response { return downloadResponse(downloadMP3(), 999) }, "http_rejected"},
		{"invalid-audio", func() *http.Response { return downloadResponse([]byte("not audio"), -1) }, "payload_rejected"},
		{"broken-frame", func() *http.Response { b := downloadMP3(); return downloadResponse(b[:len(b)-1], -1) }, "payload_rejected"},
		{"wrong-container", func() *http.Response { return downloadResponse(downloadFLAC(), -1) }, "unsupported"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return tc.response(), nil })
			req := downloadReq(t, token, "gate.mp3")
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
			if err != nil || state.Code != tc.code || state.Committed || state.Ref != nil {
				t.Fatalf("state=%+v err=%v", state, err)
			}
			if _, err := os.Stat(filepath.Join(dir, req.Filename)); !os.IsNotExist(err) {
				t.Fatal("rejected target exists")
			}
			assertDownloadClean(t, dir)
		})
	}
}

type downloadBlockedBody struct {
	read         chan struct{}
	closed       chan struct{}
	releaseClose chan struct{}
	readOnce     sync.Once
	closeOnce    sync.Once
}

func newDownloadBlockedBody() *downloadBlockedBody {
	return &downloadBlockedBody{read: make(chan struct{}), closed: make(chan struct{}), releaseClose: make(chan struct{})}
}

func (b *downloadBlockedBody) Read([]byte) (int, error) {
	b.readOnce.Do(func() { close(b.read) })
	<-b.closed
	return 0, context.Canceled
}

func (b *downloadBlockedBody) Close() error {
	b.closeOnce.Do(func() { close(b.closed) })
	<-b.releaseClose
	return nil
}

func TestDownloadCancelRevokeHoldPermitUntilCleanup(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "revoke"}[revoke], func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			bodies := []*downloadBlockedBody{newDownloadBlockedBody(), newDownloadBlockedBody()}
			var index atomic.Int32
			c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
				r := downloadResponse(nil, -1)
				r.Body = bodies[index.Add(1)-1]
				return r, nil
			})
			req := downloadReq(t, token, "cancel.mp3")
			j1 := downloadStart(t, a, ctx, epoch, c, req)
			j2 := downloadStart(t, a, ctx, epoch, c, downloadReq(t, token, "other.mp3"))
			for _, b := range bodies {
				<-b.read
			}
			if _, err := a.state.startDownload(ctx, epoch, downloadReq(t, token, "third.mp3")); !errors.Is(err, errFilesBusy) {
				t.Fatalf("active limit: %v", err)
			}
			if revoke {
				if err := a.state.revokeDirectory(ctx, epoch, token); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := c.access(a.state, ctx, epoch, req.OperationID, true); err != nil {
					t.Fatal(err)
				}
				c.mu.Lock()
				j2.cancel()
				c.mu.Unlock()
			}
			for _, b := range bodies {
				select {
				case <-b.closed:
				case <-time.After(time.Second):
					t.Fatal("body not closed")
				}
			}
			c.mu.Lock()
			active := c.active
			c.mu.Unlock()
			if active != 2 {
				t.Fatal("permit returned before blocked Close finished")
			}
			if j1.lease.released.Load() {
				t.Fatal("lease released before actual body cleanup")
			}
			select {
			case <-j1.done:
				t.Fatal("done before cleanup")
			default:
			}
			for _, b := range bodies {
				close(b.releaseClose)
			}
			downloadWait(t, j1)
			downloadWait(t, j2)
			if revoke {
				if _, err := c.access(a.state, ctx, epoch, req.OperationID, false); err == nil {
					t.Fatal("revoked progress exposed")
				}
			} else {
				state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
				if err != nil || state.Code != "cancelled" || !state.Done {
					t.Fatalf("cancel state=%+v %v", state, err)
				}
			}
			assertDownloadClean(t, dir)
		})
	}
}

func TestDownloadValidationAndRedirect(t *testing.T) {
	for _, name := range []string{"../a.mp3", "a/b.mp3", "a\\b.mp3", "a:1.mp3", "CON.mp3", "CON .mp3", "COM¹.mp3", "LPT².flac", "NUL.flac", ".hidden.mp3", "x\x00.mp3", "x?.mp3", "a.mp3 ", "a\n.mp3"} {
		if downloadFilename(name) {
			t.Errorf("accepted %q", name)
		}
	}
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	for _, raw := range []string{"file:///tmp/audio.mp3", "https://user:pass@example.invalid/a", "ftp://example.invalid/a", "https://example.invalid/a#fragment"} {
		req := downloadReq(t, token, "a.mp3")
		req.URL = raw
		if _, err := a.state.startDownload(ctx, epoch, req); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	redirectURL, _ := url.Parse("https://safe.invalid/audio")
	redirect := &http.Request{URL: redirectURL, Header: make(http.Header)}
	redirect.Header.Set("Referer", "https://source.invalid/audio?secret=hidden")
	if err := c.client.CheckRedirect(redirect, nil); err != nil || redirect.Header.Get("Referer") != "" {
		t.Fatal("signed URL referer leaked")
	}
	for _, raw := range []string{"file:///a", "https://u:p@other.invalid/a"} {
		u, _ := url.Parse(raw)
		if c.client.CheckRedirect(&http.Request{URL: u}, nil) == nil {
			t.Fatal("unsafe redirect")
		}
	}
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("OS secret https://user:pass@bad.invalid/token")
	})
	req := downloadReq(t, token, "a.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || state.Code != "network_error" {
		t.Fatalf("unsanitized error %+v %v", state, err)
	}
}

func TestDownloadClaimedCancelReportsCommitted(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	responseReady := make(chan struct{})
	releaseResponse := make(chan struct{})
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		close(responseReady)
		<-releaseResponse
		return downloadResponse(downloadMP3(), -1), nil
	})
	req := downloadReq(t, token, "claimed.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	<-responseReady
	originalMain := a.state.main
	claimed := make(chan struct{})
	releaseClaim := make(chan struct{})
	var intercepted atomic.Bool
	a.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
		err := originalMain(caller, fn)
		if err == nil && j.commit.phase.Load() == fileCommitClaimed && intercepted.CompareAndSwap(false, true) {
			close(claimed)
			<-releaseClaim
		}
		return err
	}
	close(releaseResponse)
	select {
	case <-claimed:
	case <-time.After(time.Second):
		t.Fatal("commit not claimed")
	}
	if _, err := c.access(a.state, ctx, epoch, req.OperationID, true); err != nil {
		t.Fatal(err)
	}
	close(releaseClaim)
	downloadWait(t, j)
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || !state.Committed || state.Code != "cancelled" || state.Ref != nil {
		t.Fatalf("postclaim state=%+v %v", state, err)
	}
	saved, err := os.ReadFile(filepath.Join(dir, req.Filename))
	if err != nil || !bytes.Equal(saved, downloadMP3()) {
		t.Fatal("claimed publication removed or missing")
	}
	assertDownloadClean(t, dir)
}

func TestDownloadLateEpochCannotRetireNewJobs(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	body := newDownloadBlockedBody()
	var calls atomic.Int32
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			r := downloadResponse(nil, -1)
			r.Body = body
			return r, nil
		}
		return downloadResponse(downloadMP3(), -1), nil
	})
	oldReq := downloadReq(t, token, "old.mp3")
	old := downloadStart(t, a, ctx, epoch, c, oldReq)
	<-body.read
	if err := a.state.teardown(ctx, epoch); err != nil {
		t.Fatal(err)
	}
	session, err := a.state.session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a.state.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { return []string{dir}, nil }}
	selection, err := a.state.chooseDirectory(ctx, session.Epoch)
	if err != nil || selection.Grant == nil {
		t.Fatalf("new grant: %v", err)
	}
	req := downloadReq(t, selection.Grant.Token, "new.mp3")
	req.OperationID = oldReq.OperationID
	current := downloadStart(t, a, ctx, session.Epoch, c, req)
	downloadWait(t, current)
	close(body.releaseClose)
	downloadWait(t, old)
	state, err := c.access(a.state, ctx, session.Epoch, req.OperationID, false)
	if err != nil || state.Code != "ok" || state.Ref == nil {
		t.Fatalf("old job erased new result: %+v %v", state, err)
	}
	if old.state.Ref != nil || old.state.Code != "revoked" {
		t.Fatal("old epoch issued reference")
	}
	if _, err := a.state.startDownload(ctx, epoch, downloadReq(t, token, "stale.mp3")); err == nil {
		t.Fatal("stale job registered")
	}
	assertDownloadClean(t, dir)
}

func TestDownloadBoundedRecordsAndRevokedID(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return downloadResponse(nil, -1), nil })
	first := downloadReq(t, token, "first.mp3")
	j := downloadStart(t, a, ctx, epoch, c, first)
	downloadWait(t, j)
	for i := 1; i < downloadMaxJobs; i++ {
		j = downloadStart(t, a, ctx, epoch, c, downloadReq(t, token, "failure.mp3"))
		downloadWait(t, j)
	}
	if _, err := a.state.startDownload(ctx, epoch, downloadReq(t, token, "extra.mp3")); !errors.Is(err, errFilesBusy) {
		t.Fatalf("record cap: %v", err)
	}
	state, err := c.access(a.state, ctx, epoch, first.OperationID, false)
	if err != nil || !state.Done || state.Code != "payload_rejected" {
		t.Fatal("terminal record evicted")
	}
	if err := a.state.revokeDirectory(ctx, epoch, token); err != nil {
		t.Fatal(err)
	}
	a.state.picker = fakeFilePicker{open: func(mygo.OpenDialogOptions) ([]string, error) { return []string{dir}, nil }}
	selection, err := a.state.chooseDirectory(ctx, epoch)
	if err != nil || selection.Grant == nil {
		t.Fatal("replacement grant failed")
	}
	first.GrantToken = selection.Grant.Token
	if _, err := a.state.startDownload(ctx, epoch, first); err == nil {
		t.Fatal("revoked ID reused")
	}
}

type downloadPhasedBody struct {
	data    []byte
	offset  int
	waiting chan struct{}
	release chan struct{}
}

func (b *downloadPhasedBody) Read(p []byte) (int, error) {
	if b.offset == 417 {
		close(b.waiting)
		<-b.release
	}
	if b.offset == len(b.data) {
		return 0, io.EOF
	}
	n := copy(p, b.data[b.offset:min(b.offset+417, len(b.data))])
	b.offset += n
	return n, nil
}
func (b *downloadPhasedBody) Close() error { return nil }
func TestDownloadProgressPersistsOnlyAfterCleanup(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	body := &downloadPhasedBody{data: downloadMP3(), waiting: make(chan struct{}), release: make(chan struct{})}
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) {
		r := downloadResponse(nil, -1)
		r.Body = body
		return r, nil
	})
	req := downloadReq(t, token, "progress.mp3")
	j := downloadStart(t, a, ctx, epoch, c, req)
	<-body.waiting
	state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || state.Received != 417 || state.Total != 0 || state.Done || state.Committed || state.Code != "running" {
		t.Fatalf("progress=%+v %v", state, err)
	}
	close(body.release)
	downloadWait(t, j)
	final, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || final.Received < state.Received || final.Total != 0 || !final.Done || final.Code != "ok" || final.Ref == nil {
		t.Fatalf("terminal progress=%+v %v", final, err)
	}
	// Ordinary worker lease Release must not retire a completed result.
	again, err := c.access(a.state, ctx, epoch, req.OperationID, false)
	if err != nil || again.Code != "ok" || again.Ref == nil {
		t.Fatal("normal Release discarded terminal result")
	}
}

func TestDownloadNeverReplacesDirectoryOrSymlink(t *testing.T) {
	for _, kind := range []string{"directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			target := filepath.Join(dir, "special.mp3")
			protected := filepath.Join(t.TempDir(), "protected.mp3")
			original := []byte("private fixture must remain intact")
			if err := os.WriteFile(protected, original, 0o600); err != nil {
				t.Fatal(err)
			}
			if kind == "directory" {
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Symlink(protected, target); err != nil {
					t.Fatal(err)
				}
			}
			c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return downloadResponse(downloadMP3(), -1), nil })
			req := downloadReq(t, token, "special.mp3")
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			state, err := c.access(a.state, ctx, epoch, req.OperationID, false)
			if err != nil || state.Code != "conflict" || state.Committed {
				t.Fatalf("special target state=%+v %v", state, err)
			}
			saved, err := os.ReadFile(protected)
			if err != nil || !bytes.Equal(saved, original) {
				t.Fatal("symlink target modified")
			}
			info, err := os.Lstat(target)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "directory" && !info.IsDir() || kind == "symlink" && info.Mode()&os.ModeSymlink == 0 {
				t.Fatal("special target replaced")
			}
			assertDownloadClean(t, dir)
		})
	}
}
