package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const (
	authCallbackPath   = "/login/success"
	authPrepareTimeout = time.Minute
)

// AuthCallbackPrepared reserves the callback listener before the backend creates a session.
type AuthCallbackPrepared struct {
	SessionID   string `json:"sessionId"`
	CallbackURL string `json:"callbackUrl"`
}

// AuthCallbackReceived only confirms a matching callback, never backend token exchange.
type AuthCallbackReceived struct {
	SessionID string `json:"sessionId"`
	State     string `json:"state"`
}

var authCallbackReceived = mygo.NewEvent[AuthCallbackReceived]("desktop:auth-callback")

// AuthCallback exposes only loopback callback coordination, with no credentials or tokens.
type AuthCallback struct {
	callbacks *authCallbacks
}

func (a *AuthCallback) Prepare(ctx context.Context, preferredPort int) (AuthCallbackPrepared, error) {
	page := mygo.CallerPage(ctx)
	if page == nil || page.Window().IsDestroyed() {
		return AuthCallbackPrepared{}, errors.New("auth callback requires a live calling page")
	}
	return a.callbacks.prepare(ctx, preferredPort, func(payload AuthCallbackReceived) error {
		if page.Window().IsDestroyed() || ctx.Err() != nil {
			return errors.New("auth callback page closed")
		}
		return authCallbackReceived.EmitPage(page, payload)
	})
}

// Arm must complete before opening the system browser. The expiry is Unix milliseconds.
func (a *AuthCallback) Arm(ctx context.Context, sessionID, state string, expiresAtUnixMs int64) error {
	return a.callbacks.arm(ctx, sessionID, state, expiresAtUnixMs)
}

func (a *AuthCallback) Cancel(ctx context.Context, sessionID string) error {
	return a.callbacks.cancel(ctx, sessionID)
}

func init() {
	callbacks := &authCallbacks{sessions: make(map[context.Context]*authPending)}
	mygo.Bind(&AuthCallback{callbacks: callbacks})
	mygo.App.OnQuit(callbacks.close)
}

type authPending struct {
	id        string
	owner     context.Context
	listener  net.Listener
	server    *http.Server
	timer     *time.Timer
	stopOwner func() bool
	state     string
	expires   time.Time
	emit      func(AuthCallbackReceived) error
}

type authCallbacks struct {
	mu       sync.Mutex
	sessions map[context.Context]*authPending
	closed   bool
}

// The non-streaming mygo binding context lives until page navigation/destruction,
// not method return. AfterFunc is stopped on every terminal path; no waiter per call.
func (a *authCallbacks) prepare(owner context.Context, port int, emit func(AuthCallbackReceived) error) (AuthCallbackPrepared, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || owner.Err() != nil {
		return AuthCallbackPrepared{}, errors.New("auth callback owner unavailable")
	}
	// Zero asks the OS for an unused callback port. The long-lived playback
	// control listener owns the legacy default, while OAuth uses this returned URL.
	if port < 0 || port > 65535 {
		return AuthCallbackPrepared{}, errors.New("auth callback port must be between 0 and 65535")
	}
	if old := a.sessions[owner]; old != nil {
		a.releaseLocked(old, true)
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return AuthCallbackPrepared{}, fmt.Errorf("auth callback port %d unavailable", port)
	}
	p := &authPending{
		id: rand.Text(), owner: owner, listener: listener, emit: emit,
		expires: time.Now().Add(authPrepareTimeout),
	}
	p.server = &http.Server{
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.receive(p, w, r) }),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       5 * time.Second,
		MaxHeaderBytes:    32 * 1024,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	p.server.SetKeepAlivesEnabled(false)
	a.sessions[owner] = p
	p.stopOwner = context.AfterFunc(owner, func() { a.release(p) })
	deadline := p.expires
	p.timer = time.AfterFunc(time.Until(deadline), func() { a.expire(p, deadline) })
	go func() {
		_ = p.server.Serve(listener)
		a.release(p)
	}()
	return AuthCallbackPrepared{SessionID: p.id, CallbackURL: "http://" + listener.Addr().String() + authCallbackPath}, nil
}

func (a *authCallbacks) arm(owner context.Context, id, state string, expiresAtUnixMs int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.sessions[owner]
	if p == nil || p.id != id || owner.Err() != nil || !time.Now().Before(p.expires) {
		return errors.New("auth callback session unavailable")
	}
	if p.state != "" {
		return errors.New("auth callback session already armed")
	}
	expires := time.UnixMilli(expiresAtUnixMs)
	if strings.TrimSpace(state) == "" || len(state) > 4096 || !expires.After(time.Now()) {
		return errors.New("auth callback state or expiry invalid")
	}
	p.state, p.expires = state, expires
	p.timer.Stop()
	// Capture the deadline: a preparation timer already running must not expire
	// a session whose backend expiry was just installed.
	p.timer = time.AfterFunc(time.Until(expires), func() { a.expire(p, expires) })
	return nil
}

func (a *authCallbacks) cancel(owner context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.sessions[owner]
	if p == nil || p.id != id {
		return errors.New("auth callback session unavailable")
	}
	a.releaseLocked(p, true)
	return nil
}

func (a *authCallbacks) expire(p *authPending, deadline time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p.expires.Equal(deadline) {
		a.releaseLocked(p, true)
	}
}

func (a *authCallbacks) release(p *authPending) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.releaseLocked(p, true)
}

func (a *authCallbacks) releaseLocked(p *authPending, closeConnections bool) {
	if a.sessions[p.owner] != p {
		return
	}
	delete(a.sessions, p.owner)
	p.timer.Stop()
	p.stopOwner()
	_ = p.listener.Close()
	if closeConnections {
		_ = p.server.Close()
	}
}

func (a *authCallbacks) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	for _, p := range a.sessions {
		a.releaseLocked(p, true)
	}
}

func (a *authCallbacks) receive(p *authPending, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Connection", "close")
	if r.URL.EscapedPath() != authCallbackPath {
		http.Error(w, "Callback unavailable.", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Callback unavailable.", http.StatusMethodNotAllowed)
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	states := query["state"]
	if err != nil || len(query) != 1 || len(states) != 1 || states[0] == "" {
		http.Error(w, "Callback rejected.", http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	if a.sessions[p.owner] != p || p.owner.Err() != nil || p.state == "" || !time.Now().Before(p.expires) || states[0] != p.state {
		a.mu.Unlock()
		http.Error(w, "Callback rejected.", http.StatusBadRequest)
		return
	}
	// Claim and consume under the lock; cancellation/replacement that wins first
	// prevents delivery. Once claimed, the event may finish after cancellation,
	// so consumers must also match sessionId against their current session.
	payload := AuthCallbackReceived{SessionID: p.id, State: p.state}
	a.releaseLocked(p, false)
	a.mu.Unlock()
	// Native event dispatch must never hold the service mutex (including on quit).
	err = p.emit(payload)
	if err != nil {
		http.Error(w, "Callback unavailable.", http.StatusGone)
		return
	}
	_, _ = io.WriteString(w, "Callback received. Return to the app to check authorization.\n")
}
