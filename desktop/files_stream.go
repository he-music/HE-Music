package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
)

const (
	localAudioMaxTickets         = 16
	localAudioLifetime           = 10 * time.Minute
	localAudioWriteTimeout       = 5 * time.Second
	localAudioMaxBytes     int64 = 32 << 20
)

var errLocalAudio = errors.New("local audio is unavailable")

// LocalAudioTicket contains only transient bearer credentials, never filesystem paths.
type LocalAudioTicket struct {
	TicketID string `json:"ticketId"`
	URL      string `json:"url"`
	Version  string `json:"version"`
}

type localAudioTicket struct {
	id     string
	ref    LocalFileRef
	lease  *directoryLease
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

type localAudioServer struct {
	state    *nativeFilesState
	mu       sync.Mutex
	host     string
	server   *http.Server
	tickets  map[string]*localAudioTicket
	closed   bool
	listen   func(string, string) (net.Listener, error)
	lifetime time.Duration
}

// The registry keeps HTTP locks and IO outside the main actor. Lifecycle owners
// may call shutdownLocalAudio outside the actor at final application shutdown.
var localAudioServers = struct {
	sync.Mutex
	servers map[*nativeFilesState]*localAudioServer
}{servers: make(map[*nativeFilesState]*localAudioServer)}

func audioServerFor(s *nativeFilesState) *localAudioServer {
	localAudioServers.Lock()
	defer localAudioServers.Unlock()
	a := localAudioServers.servers[s]
	if a == nil {
		a = &localAudioServer{state: s, tickets: make(map[string]*localAudioTicket), listen: net.Listen}
		localAudioServers.servers[s] = a
	}
	return a
}

func (f *NativeFiles) OpenLocalAudio(ctx context.Context, epoch uint64, ref LocalFileRef) (LocalAudioTicket, error) {
	return audioServerFor(&f.state).open(ctx, epoch, ref)
}

func (f *NativeFiles) CloseLocalAudio(ctx context.Context, epoch uint64, ticketID string) error {
	return audioServerFor(&f.state).closeTicket(ctx, epoch, ticketID)
}

func (a *localAudioServer) ticketLifetime() time.Duration {
	if a.lifetime > 0 {
		return a.lifetime
	}
	return localAudioLifetime
}

func (a *localAudioServer) start() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return errLocalAudio
	}
	if a.host != "" {
		return nil
	}
	listener, err := a.listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errLocalAudio
	}
	a.host = listener.Addr().String()
	a.server = &http.Server{Handler: a, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: localAudioWriteTimeout, IdleTimeout: localAudioWriteTimeout, MaxHeaderBytes: 8192}
	a.server.SetKeepAlivesEnabled(false)
	go func() { _ = a.server.Serve(listener) }()
	return nil
}

func (a *localAudioServer) open(ctx context.Context, epoch uint64, ref LocalFileRef) (LocalAudioTicket, error) {
	lease, err := a.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		return LocalAudioTicket{}, err
	}
	accepted := false
	defer func() {
		if !accepted {
			lease.Release()
		}
	}()
	file, err := a.state.resolveLocalFile(lease, ref)
	if err != nil {
		return LocalAudioTicket{}, errLocalAudio
	}
	stopRead := cancelLocalAudioIO(lease.Context(), file, nil)
	_, err = localAudioMIME(file)
	stopRead()
	file.Close()
	if err != nil {
		return LocalAudioTicket{}, errLocalAudio
	}
	id, err := newDirectoryToken()
	if err != nil {
		return LocalAudioTicket{}, errLocalAudio
	}
	if err = a.start(); err != nil {
		return LocalAudioTicket{}, err
	}
	if err = a.state.checkLease(lease); err != nil {
		return LocalAudioTicket{}, err
	}
	ticketCtx, cancel := context.WithTimeout(lease.Context(), a.ticketLifetime())
	t := &localAudioTicket{id: id, ref: ref, lease: lease, ctx: ticketCtx, cancel: cancel, done: make(chan struct{})}
	a.mu.Lock()
	if a.closed || ticketCtx.Err() != nil || len(a.tickets) >= localAudioMaxTickets {
		a.mu.Unlock()
		cancel()
		return LocalAudioTicket{}, errLocalAudio
	}
	a.tickets[id] = t
	host := a.host
	a.mu.Unlock()
	accepted = true
	context.AfterFunc(ticketCtx, func() {
		a.mu.Lock()
		if a.tickets[id] == t {
			delete(a.tickets, id)
		}
		a.mu.Unlock()
		cancel()
		lease.Release()
		close(t.done)
	})
	// A result that lost authorization while preparing the URL is never published.
	if err = a.state.checkLease(lease); err != nil || ticketCtx.Err() != nil {
		cancel()
		return LocalAudioTicket{}, errLocalAudio
	}
	return LocalAudioTicket{TicketID: id, URL: "http://" + host + "/" + id, Version: ref.Version}, nil
}

// Content is inspected through the validated FD, independent of suffix. This
// first slice deliberately limits files to the same bounded MP3/FLAC parser as scan.
func localAudioMIME(file *os.File) (string, error) {
	stat, err := file.Stat()
	if err != nil || stat.Size() <= 0 || stat.Size() > localAudioMaxBytes {
		return "", errLocalAudio
	}
	info, err := metadata.ParseScan(file, stat.Size())
	if err != nil || info.SampleRateHz <= 0 || info.Channels <= 0 {
		return "", errLocalAudio
	}
	switch strings.ToLower(info.Container) {
	case "mp3":
		return "audio/mpeg", nil
	case "flac":
		return "audio/flac", nil
	}
	return "", errLocalAudio
}

func (a *localAudioServer) closeTicket(ctx context.Context, epoch uint64, id string) error {
	// Acquire/check an owner capability before consulting bearer credentials.
	if err := a.state.main(ctx, func(_ *mygo.Window) error {
		if !a.state.owns(ctx, epoch) {
			return errFilesOwner
		}
		return nil
	}); err != nil {
		return err
	}
	a.mu.Lock()
	t := a.tickets[id]
	a.mu.Unlock()
	if t == nil {
		return nil
	}
	if t.lease.owner != ctx || t.lease.epoch != epoch {
		return errLocalAudio
	}
	if err := a.state.checkLease(t.lease); err != nil {
		return err
	}
	t.cancel()
	return nil
}

// shutdownLocalAudio must run outside the main actor. Revoke already propagates
// through grant contexts; this hook additionally closes the owned listener.
func (f *NativeFiles) shutdownLocalAudio() error {
	localAudioServers.Lock()
	a := localAudioServers.servers[&f.state]
	delete(localAudioServers.servers, &f.state)
	localAudioServers.Unlock()
	if a == nil {
		return nil
	}
	return a.shutdown()
}
func (a *localAudioServer) shutdown() error {
	a.mu.Lock()
	a.closed = true
	tickets := make([]*localAudioTicket, 0, len(a.tickets))
	for _, t := range a.tickets {
		tickets = append(tickets, t)
	}
	server := a.server
	a.mu.Unlock()
	for _, t := range tickets {
		t.cancel()
	}
	if server != nil {
		return server.Close()
	}
	return nil
}

// HTTP has no SDK caller identity: possession of the secret URL is sufficient.
// CORS is intentionally not used as authentication. Clients must pause, clear src
// and load on revoke: bytes already delivered to their caches cannot be recalled.
func (a *localAudioServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Host != a.host || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" || len(r.URL.Path) != 65 || r.URL.Path[0] != '/' {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	a.mu.Lock()
	t := a.tickets[r.URL.Path[1:]]
	a.mu.Unlock()
	if t == nil || t.ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	// Each request owns a separate lease and FD, so cancellation cannot release a
	// Root while its request still runs or disturb another ticket's seek offset.
	lease, err := a.state.acquireDirectory(t.lease.owner, t.lease.epoch, t.ref.GrantToken)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer lease.Release()
	ctx, cancel := context.WithCancel(r.Context())
	stopTicket := context.AfterFunc(t.ctx, cancel)
	stopLease := context.AfterFunc(lease.Context(), cancel)
	defer func() { stopTicket(); stopLease(); cancel() }()
	file, err := a.state.resolveLocalFile(lease, t.ref)
	if err != nil {
		t.cancel()
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(localAudioWriteTimeout))
	defer cancelLocalAudioIO(ctx, file, controller)()
	mime, err := localAudioMIME(file)
	if err != nil || ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("ETag", `"`+t.ref.Version+`"`)
	http.ServeContent(&localAudioWriter{ResponseWriter: w, ctx: ctx}, r, "", time.Time{}, &localAudioReader{file: file, ctx: ctx})
}

type localAudioReader struct {
	file *os.File
	ctx  context.Context
}

func (r *localAudioReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if len(p) > 32<<10 {
		p = p[:32<<10]
	}
	return r.file.Read(p)
}
func (r *localAudioReader) Seek(offset int64, whence int) (int64, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.file.Seek(offset, whence)
}

var _ io.ReadSeeker = (*localAudioReader)(nil)

type localAudioWriter struct {
	http.ResponseWriter
	ctx context.Context
}

func (w *localAudioWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(p)
}

func (w *localAudioWriter) WriteHeader(status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.ResponseWriter.WriteHeader(status)
}

// The returned cleanup joins a running callback before its caller releases Root.
func cancelLocalAudioIO(ctx context.Context, file *os.File, controller *http.ResponseController) func() {
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = file.Close()
		if controller != nil {
			_ = controller.SetWriteDeadline(time.Now())
		}
		close(stopped)
	})
	return func() {
		if !stop() {
			<-stopped
		}
	}
}

// invalidateLocalAudio is an outside-actor integration hook for a future file
// replacement consumer. Cancel the old revision before draining readers/commit.
func (f *NativeFiles) invalidateLocalAudio(ref LocalFileRef) {
	localAudioServers.Lock()
	a := localAudioServers.servers[&f.state]
	localAudioServers.Unlock()
	if a == nil {
		return
	}
	a.invalidate(ref)
}
func (a *localAudioServer) invalidate(ref LocalFileRef) {
	a.mu.Lock()
	var tickets []*localAudioTicket
	for _, ticket := range a.tickets {
		if ticket.ref.FileID == ref.FileID && ticket.ref.Version == ref.Version {
			tickets = append(tickets, ticket)
		}
	}
	a.mu.Unlock()
	for _, ticket := range tickets {
		ticket.cancel()
	}
}
