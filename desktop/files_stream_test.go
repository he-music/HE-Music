package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func audioAwait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("audio cleanup did not finish")
	}
}

func audioFixture(t *testing.T, format string) (*localAudioServer, context.Context, uint64, LocalFileRef, []byte, string) {
	t.Helper()
	actor, ctx, epoch, token, dir := scanTestGrant(t)
	path := filepath.Join(dir, "fixture.data")
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("ffmpeg test fixture generator required")
	}
	codec := "libmp3lame"
	if format == "flac" {
		codec = "flac"
	}
	cmd := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.1", "-c:a", codec, "-f", format, path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := actor.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	ref, file, err := actor.state.registerLocalFile(lease, "fixture.data")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	lease.Release()
	a := &localAudioServer{state: actor.state, host: "127.0.0.1:34567", tickets: make(map[string]*localAudioTicket), listen: func(string, string) (net.Listener, error) {
		t.Error("unexpected listener call")
		return nil, errors.New("disabled")
	}}
	t.Cleanup(func() {
		a.mu.Lock()
		tickets := make([]*localAudioTicket, 0, len(a.tickets))
		for _, ticket := range a.tickets {
			tickets = append(tickets, ticket)
		}
		a.mu.Unlock()
		_ = a.shutdown()
		for _, ticket := range tickets {
			audioAwait(t, ticket.done)
		}
	})
	return a, ctx, epoch, *ref, data, path
}
func audioOpen(t *testing.T, a *localAudioServer, ctx context.Context, epoch uint64, ref LocalFileRef) LocalAudioTicket {
	t.Helper()
	ticket, err := a.open(ctx, epoch, ref)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ticket.URL, ref.GrantToken) || strings.Contains(ticket.URL, ref.RelativePath) || len(ticket.TicketID) != 64 {
		t.Fatal("credential leaked path/grant")
	}
	return ticket
}
func audioRequest(a *localAudioServer, ticket LocalAudioTicket, method, rangeHeader string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, ticket.URL, nil)
	if rangeHeader != "" {
		r.Header.Set("Range", rangeHeader)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func TestLocalAudioHTTP(t *testing.T) {
	for _, format := range []string{"mp3", "flac"} {
		t.Run(format, func(t *testing.T) {
			a, ctx, epoch, ref, data, _ := audioFixture(t, format)
			ticket := audioOpen(t, a, ctx, epoch, ref)
			head := audioRequest(a, ticket, "HEAD", "")
			mime := "audio/mpeg"
			if format == "flac" {
				mime = "audio/flac"
			}
			if head.Header().Get("Content-Type") != mime || head.Header().Get("ETag") != `"`+ref.Version+`"` || head.Header().Get("Content-Length") == "" {
				t.Fatal("missing trusted media headers")
			}
			for _, test := range []struct {
				method, rng string
				status      int
				want        []byte
			}{
				{"GET", "", 200, data}, {"HEAD", "", 200, nil}, {"GET", "bytes=2-9", 206, data[2:10]},
				{"GET", "bytes=-7", 206, data[len(data)-7:]}, {"GET", "bytes=999999-", 416, nil},
			} {
				w := audioRequest(a, ticket, test.method, test.rng)
				if w.Code != test.status {
					t.Fatalf("%s %s: %d", test.method, test.rng, w.Code)
				}
				if test.status != 416 && !bytes.Equal(w.Body.Bytes(), test.want) {
					t.Fatal("unexpected response bytes")
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("cache enabled")
				}
			}
			for _, etag := range []string{`"` + ref.Version + `"`, `"other"`} {
				r := httptest.NewRequest("GET", ticket.URL, nil)
				r.Header.Set("Range", "bytes=0-1")
				r.Header.Set("If-Range", etag)
				w := httptest.NewRecorder()
				a.ServeHTTP(w, r)
				expected := http.StatusOK
				if etag == `"`+ref.Version+`"` {
					expected = http.StatusPartialContent
				}
				if w.Code != expected {
					t.Fatalf("If-Range: %d", w.Code)
				}
			}
			for _, test := range []struct {
				method, url, host string
				status            int
			}{
				{"GET", ticket.URL + "?x=1", "", 404}, {"GET", ticket.URL + "?", "", 404}, {"GET", ticket.URL + "/extra", "", 404},
				{"GET", ticket.URL, "evil.example", 404}, {"POST", ticket.URL, "", 405},
				{"GET", "http://" + a.host + "/" + strings.Repeat("0", 64), "", 404},
			} {
				r := httptest.NewRequest(test.method, test.url, nil)
				if test.host != "" {
					r.Host = test.host
				}
				w := httptest.NewRecorder()
				a.ServeHTTP(w, r)
				if w.Code != test.status {
					t.Fatalf("invalid request: %s %s %d", test.method, test.url, w.Code)
				}
			}
		})
	}
}

func TestLocalAudioAuthorizationVersionAndFormat(t *testing.T) {
	a, ctx, epoch, ref, _, path := audioFixture(t, "mp3")
	foreign, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, test := range []struct {
		ctx   context.Context
		epoch uint64
		ref   LocalFileRef
	}{
		{foreign, epoch, ref}, {ctx, epoch + 1, ref}, {ctx, epoch, LocalFileRef{GrantToken: ref.GrantToken, RelativePath: "fixture.data", FileID: "forged", Version: ref.Version}},
	} {
		if _, err := a.open(test.ctx, test.epoch, test.ref); err == nil {
			t.Fatal("invalid authorization accepted")
		}
	}
	ticket := audioOpen(t, a, ctx, epoch, ref)
	if err := a.closeTicket(foreign, epoch, ticket.TicketID); err == nil {
		t.Fatal("foreign close accepted")
	}
	if err := a.closeTicket(ctx, epoch+1, ticket.TicketID); err == nil {
		t.Fatal("stale close accepted")
	}
	a.mu.Lock()
	old := a.tickets[ticket.TicketID]
	a.mu.Unlock()
	if err := os.WriteFile(path, []byte("not audio, even with a trusted reference"), 0o600); err != nil {
		t.Fatal(err)
	}
	if w := audioRequest(a, ticket, "GET", ""); w.Code != 404 {
		t.Fatal("changed version served")
	}
	audioAwait(t, old.done)
	lease, err := a.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		t.Fatal(err)
	}
	newRef, file, err := a.state.registerLocalFile(lease, ref.RelativePath)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	lease.Release()
	if _, err = a.open(ctx, epoch, *newRef); err == nil {
		t.Fatal("non audio accepted")
	}
}

func TestLocalAudioLimitExpiryAndClose(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "flac")
	var first LocalAudioTicket
	for n := 0; n < localAudioMaxTickets; n++ {
		ticket := audioOpen(t, a, ctx, epoch, ref)
		if n == 0 {
			first = ticket
		}
	}
	if _, err := a.open(ctx, epoch, ref); err == nil {
		t.Fatal("ticket limit not enforced")
	}
	a.mu.Lock()
	old := a.tickets[first.TicketID]
	a.mu.Unlock()
	if err := a.closeTicket(ctx, epoch, first.TicketID); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, old.done)
	if w := audioRequest(a, first, "GET", ""); w.Code != 404 {
		t.Fatal("closed ticket served")
	}
	a.lifetime = 20 * time.Millisecond
	expiry := audioOpen(t, a, ctx, epoch, ref)
	a.mu.Lock()
	expiring := a.tickets[expiry.TicketID]
	a.mu.Unlock()
	audioAwait(t, expiring.done)
	if w := audioRequest(a, expiry, "GET", ""); w.Code != 404 {
		t.Fatal("expired ticket served")
	}
}

type audioBlockedWriter struct {
	header       http.Header
	entered      chan struct{}
	released     chan struct{}
	once         sync.Once
	deadlineOnce sync.Once
}

func (w *audioBlockedWriter) Header() http.Header { return w.header }
func (w *audioBlockedWriter) WriteHeader(int)     {}
func (w *audioBlockedWriter) Write([]byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.released
	return 0, context.Canceled
}
func (w *audioBlockedWriter) SetWriteDeadline(deadline time.Time) error {
	if !deadline.After(time.Now()) {
		w.deadlineOnce.Do(func() { close(w.released) })
	}
	return nil
}

func TestLocalAudioRevokeBlockedWriteAndIndependentTicket(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "mp3")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	other := audioOpen(t, a, ctx, epoch, ref)
	w := &audioBlockedWriter{header: make(http.Header), entered: make(chan struct{}), released: make(chan struct{})}
	done := make(chan struct{})
	go func() { defer close(done); a.ServeHTTP(w, httptest.NewRequest("GET", ticket.URL, nil)) }()
	audioAwait(t, w.entered)
	if err := a.closeTicket(ctx, epoch, ticket.TicketID); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, done)
	if result := audioRequest(a, other, "GET", ""); result.Code != 200 {
		t.Fatal("other ticket affected")
	}
	// Revoking the actual grant closes every ticket and drains request FD holds.
	a.mu.Lock()
	remaining := a.tickets[other.TicketID]
	a.mu.Unlock()
	handle := remaining.lease.handle
	if err := a.state.revokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, remaining.done)
	a.state.cleanup.Wait()
	if handle.leaseCount.Load() != 0 {
		t.Fatal("request lease leaked")
	}
	if _, err := handle.root.Stat("."); err == nil {
		t.Fatal("Root was not closed")
	}
	if result := audioRequest(a, other, "GET", ""); result.Code != 404 {
		t.Fatal("revoked grant served")
	}
}

func TestLocalAudioReaderCancellationClosesFD(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "reader")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cleanup := cancelLocalAudioIO(ctx, file, nil)
	reader := &localAudioReader{file: file, ctx: ctx}
	cancel()
	cleanup()
	if _, err = reader.Read(make([]byte, 2)); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err = file.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("FD not closed: %v", err)
	}
	if _, err = reader.Seek(0, io.SeekStart); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

type audioFakeListener struct {
	closed chan struct{}
	once   sync.Once
}

func (l *audioFakeListener) Accept() (net.Conn, error) { <-l.closed; return nil, net.ErrClosed }
func (l *audioFakeListener) Close() error              { l.once.Do(func() { close(l.closed) }); return nil }
func (l *audioFakeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 34567}
}

func TestLocalAudioLateURLCleanup(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "flac")
	a.host = ""
	entered, proceed := make(chan struct{}), make(chan struct{})
	listener := &audioFakeListener{closed: make(chan struct{})}
	a.listen = func(network, address string) (net.Listener, error) {
		if network != "tcp4" || address != "127.0.0.1:0" {
			t.Error("unsafe bind address")
		}
		close(entered)
		<-proceed
		return listener, nil
	}
	result := make(chan error, 1)
	go func() {
		ticket, err := a.open(ctx, epoch, ref)
		if ticket.URL != "" {
			t.Error("late URL published")
		}
		result <- err
	}()
	audioAwait(t, entered)
	if err := a.state.revokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
		t.Fatal(err)
	}
	close(proceed)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("late success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open did not exit")
	}
	a.mu.Lock()
	count := len(a.tickets)
	a.mu.Unlock()
	if count != 0 {
		t.Fatal("late ticket leaked")
	}
	if err := a.shutdown(); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, listener.closed)
}

func TestLocalAudioGrantRevokeDuringRequest(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "mp3")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	a.mu.Lock()
	entry := a.tickets[ticket.TicketID]
	a.mu.Unlock()
	w := &audioBlockedWriter{header: make(http.Header), entered: make(chan struct{}), released: make(chan struct{})}
	done := make(chan struct{})
	go func() { defer close(done); a.ServeHTTP(w, httptest.NewRequest("GET", ticket.URL, nil)) }()
	audioAwait(t, w.entered)
	if err := a.state.revokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, done)
	audioAwait(t, entry.done)
	a.state.cleanup.Wait()
	if entry.lease.handle.leaseCount.Load() != 0 {
		t.Fatal("Root reference leaked")
	}
	if _, err := entry.lease.handle.root.Stat("."); err == nil {
		t.Fatal("Root still open")
	}
}

func TestLocalAudioRevisionInvalidation(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "flac")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	a.mu.Lock()
	entry := a.tickets[ticket.TicketID]
	a.mu.Unlock()
	a.invalidate(ref)
	audioAwait(t, entry.done)
	if w := audioRequest(a, ticket, "GET", ""); w.Code != 404 {
		t.Fatal("invalidated revision served")
	}
}

func TestLocalAudioRequestCancellation(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "mp3")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	requestCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &audioBlockedWriter{header: make(http.Header), entered: make(chan struct{}), released: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.ServeHTTP(w, httptest.NewRequest("GET", ticket.URL, nil).WithContext(requestCtx))
	}()
	audioAwait(t, w.entered)
	cancel()
	audioAwait(t, done)
	if result := audioRequest(a, ticket, "GET", ""); result.Code != 200 {
		t.Fatal("request cancellation revoked reusable ticket")
	}
}

func TestLocalAudioOwnerRevoke(t *testing.T) {
	a, ctx, epoch, ref, _, _ := audioFixture(t, "flac")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	a.mu.Lock()
	entry := a.tickets[ticket.TicketID]
	a.mu.Unlock()
	a.state.dispatch(a.state.revoke)
	audioAwait(t, entry.done)
	a.state.cleanup.Wait()
	if entry.lease.handle.leaseCount.Load() != 0 {
		t.Fatal("owner revoke leaked lease")
	}
	if w := audioRequest(a, ticket, "GET", ""); w.Code != 404 {
		t.Fatal("owner revoked URL served")
	}
}
