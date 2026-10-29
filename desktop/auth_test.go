package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type authFixture struct {
	callbacks *authCallbacks
	owner     context.Context
	cancel    context.CancelFunc
	client    *http.Client
	events    chan AuthCallbackReceived
}

func newAuthFixture(t *testing.T) *authFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	f := &authFixture{
		callbacks: &authCallbacks{sessions: make(map[context.Context]*authPending)},
		owner:     ctx, cancel: cancel,
		client: &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}},
		events: make(chan AuthCallbackReceived, 16),
	}
	t.Cleanup(func() { cancel(); f.callbacks.close(); f.client.CloseIdleConnections() })
	return f
}

func unusedAuthPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func (f *authFixture) prepare(t *testing.T, port int) AuthCallbackPrepared {
	t.Helper()
	p, err := f.callbacks.prepare(f.owner, port, func(event AuthCallbackReceived) error {
		f.events <- event
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (f *authFixture) arm(t *testing.T, p AuthCallbackPrepared, state string, expiry time.Time) {
	t.Helper()
	if err := f.callbacks.arm(f.owner, p.SessionID, state, expiry.UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func (f *authFixture) request(t *testing.T, method, target string, expected int) {
	t.Helper()
	request, err := http.NewRequest(method, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != expected {
		t.Fatalf("HTTP status = %d, want %d", response.StatusCode, expected)
	}
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("missing callback privacy headers")
	}
	if strings.Contains(string(body), "test-state") || strings.Contains(string(body), "secret-marker") {
		t.Fatal("callback reflected sensitive input")
	}
	if strings.Contains(strings.ToLower(string(body)), "success") {
		t.Fatal("callback must not claim backend login success")
	}
}

func (f *authFixture) noEvent(t *testing.T) {
	t.Helper()
	select {
	case <-f.events:
		t.Fatal("unexpected callback event")
	default:
	}
}

func assertAuthPortReleased(t *testing.T, callbackURL string) {
	t.Helper()
	parsed, err := url.Parse(callbackURL)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		listener, err := net.Listen("tcp4", parsed.Host)
		if err == nil {
			_ = listener.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("callback listener was not released")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAuthCallbackHTTPValidationAndMatch(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, unusedAuthPort(t))
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state", http.StatusBadRequest)
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	cases := []struct {
		method, suffix string
		status         int
	}{
		{http.MethodGet, "", http.StatusBadRequest},
		{http.MethodGet, "?state=", http.StatusBadRequest},
		{http.MethodGet, "?state=wrong", http.StatusBadRequest},
		{http.MethodGet, "?state=test-state&state=test-state", http.StatusBadRequest},
		{http.MethodGet, "?state=test-state&token=secret-marker", http.StatusBadRequest},
		{http.MethodGet, "?state=%zz", http.StatusBadRequest},
		{http.MethodPost, "?state=test-state", http.StatusMethodNotAllowed},
	}
	for _, test := range cases {
		f.request(t, test.method, p.CallbackURL+test.suffix, test.status)
		f.noEvent(t)
	}
	f.request(t, http.MethodGet, strings.TrimSuffix(p.CallbackURL, authCallbackPath)+"/other?state=test-state", http.StatusNotFound)
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state", http.StatusOK)
	select {
	case event := <-f.events:
		if event.SessionID != p.SessionID || event.State != "test-state" {
			t.Fatal("callback event did not match its session")
		}
	case <-time.After(time.Second):
		t.Fatal("missing matching callback")
	}
	assertAuthPortReleased(t, p.CallbackURL)
	if err := f.callbacks.arm(f.owner, p.SessionID, "test-state", time.Now().Add(time.Minute).UnixMilli()); err == nil {
		t.Fatal("consumed session was rearmed")
	}
}

func TestAuthCallbackAcceptsArmedURLEncodedState(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, unusedAuthPort(t))
	state := strings.Repeat("/", 4096)
	f.arm(t, p, state, time.Now().Add(time.Minute))
	f.request(t, http.MethodGet, p.CallbackURL+"?state="+url.QueryEscape(state), http.StatusOK)
	select {
	case event := <-f.events:
		if event.SessionID != p.SessionID || event.State != state {
			t.Fatal("callback event did not match the armed state")
		}
	case <-time.After(time.Second):
		t.Fatal("missing callback for an accepted encoded state")
	}
	assertAuthPortReleased(t, p.CallbackURL)
}

func TestAuthCallbackDuplicateRequestsEmitOnce(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, unusedAuthPort(t))
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	var group sync.WaitGroup
	for range 12 {
		group.Go(func() {
			response, err := f.client.Get(p.CallbackURL + "?state=test-state")
			if err == nil {
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}
		})
	}
	group.Wait()
	if len(f.events) != 1 {
		t.Fatalf("callback event count = %d, want 1", len(f.events))
	}
	assertAuthPortReleased(t, p.CallbackURL)
}

func TestAuthCallbackCancelReplaceAndLateRequest(t *testing.T) {
	f := newAuthFixture(t)
	port := unusedAuthPort(t)
	old := f.prepare(t, port)
	f.arm(t, old, "test-state-old", time.Now().Add(time.Minute))
	p := f.prepare(t, port)
	if p.SessionID == old.SessionID {
		t.Fatal("replacement reused session id")
	}
	f.arm(t, p, "test-state-new", time.Now().Add(time.Minute))
	if err := f.callbacks.cancel(f.owner, old.SessionID); err == nil {
		t.Fatal("old cancellation targeted replacement")
	}
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state-old", http.StatusBadRequest)
	f.noEvent(t)
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state-new", http.StatusOK)
	if event := <-f.events; event.SessionID != p.SessionID {
		t.Fatal("late callback associated with wrong session")
	}
	cancelled := f.prepare(t, port)
	f.arm(t, cancelled, "test-state-cancelled", time.Now().Add(time.Minute))
	if err := f.callbacks.cancel(f.owner, cancelled.SessionID); err != nil {
		t.Fatal(err)
	}
	assertAuthPortReleased(t, cancelled.CallbackURL)
	current := f.prepare(t, port)
	f.arm(t, current, "test-state-current", time.Now().Add(time.Minute))
	f.request(t, http.MethodGet, current.CallbackURL+"?state=test-state-cancelled", http.StatusBadRequest)
	f.noEvent(t)
}

func TestAuthCallbackExpiryAndInvalidArm(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, unusedAuthPort(t))
	for _, test := range []struct {
		state  string
		expiry int64
	}{
		{"", time.Now().Add(time.Minute).UnixMilli()},
		{" ", time.Now().Add(time.Minute).UnixMilli()},
		{"test-state", time.Now().Add(-time.Second).UnixMilli()},
		{strings.Repeat("x", 4097), time.Now().Add(time.Minute).UnixMilli()},
	} {
		if err := f.callbacks.arm(f.owner, p.SessionID, test.state, test.expiry); err == nil {
			t.Fatal("accepted invalid state or expiry")
		}
	}
	f.arm(t, p, "test-state", time.Now().Add(40*time.Millisecond))
	if err := f.callbacks.arm(f.owner, p.SessionID, "replacement", time.Now().Add(time.Minute).UnixMilli()); err == nil {
		t.Fatal("accepted rearm")
	}
	assertAuthPortReleased(t, p.CallbackURL)
	if err := f.callbacks.arm(f.owner, p.SessionID, "test-state", time.Now().Add(time.Minute).UnixMilli()); err == nil {
		t.Fatal("accepted expired session")
	}
	f.noEvent(t)
}

func TestAuthCallbackOwnerAndApplicationLifecycle(t *testing.T) {
	for _, end := range []string{"page-close", "application-quit", "cancel-unarmed"} {
		t.Run(end, func(t *testing.T) {
			f := newAuthFixture(t)
			p := f.prepare(t, unusedAuthPort(t))
			switch end {
			case "page-close":
				f.cancel()
			case "application-quit":
				f.callbacks.close()
			case "cancel-unarmed":
				if err := f.callbacks.cancel(f.owner, p.SessionID); err != nil {
					t.Fatal(err)
				}
			}
			assertAuthPortReleased(t, p.CallbackURL)
			f.noEvent(t)
			if end != "cancel-unarmed" {
				if _, err := f.callbacks.prepare(f.owner, unusedAuthPort(t), func(AuthCallbackReceived) error { return nil }); err == nil {
					t.Fatal("prepared for closed owner/application")
				}
			}
		})
	}
}

func TestAuthCallbackOwnerIsolationAndPortConflict(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, unusedAuthPort(t))
	other, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.callbacks.arm(other, p.SessionID, "test-state", time.Now().Add(time.Minute).UnixMilli()); err == nil {
		t.Fatal("another owner armed the session")
	}
	if err := f.callbacks.cancel(other, p.SessionID); err == nil {
		t.Fatal("another owner cancelled the session")
	}
	parsed, _ := url.Parse(p.CallbackURL)
	port, _ := strconv.Atoi(parsed.Port())
	if _, err := f.callbacks.prepare(other, port, func(AuthCallbackReceived) error { return nil }); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatal("expected explicit port conflict")
	}
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state", http.StatusOK)
	if event := <-f.events; event.SessionID != p.SessionID {
		t.Fatal("wrong owner received event")
	}
	for _, invalid := range []int{-1, 65536} {
		if _, err := f.callbacks.prepare(other, invalid, func(AuthCallbackReceived) error { return nil }); err == nil {
			t.Fatal("accepted invalid port")
		}
	}
}

func TestAuthCallbackSystemAssignedPort(t *testing.T) {
	f := newAuthFixture(t)
	p := f.prepare(t, 0)
	u, err := url.Parse(p.CallbackURL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Path != authCallbackPath {
		t.Fatal("unexpected callback URL")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		t.Fatal("system did not assign a callback port")
	}
}

func TestAuthCallbackEmitterCanCloseService(t *testing.T) {
	f := newAuthFixture(t)
	p, err := f.callbacks.prepare(f.owner, unusedAuthPort(t), func(AuthCallbackReceived) error {
		f.callbacks.close()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state", http.StatusOK)
	assertAuthPortReleased(t, p.CallbackURL)
}

func TestAuthCallbackClaimAndConcurrentClose(t *testing.T) {
	f := newAuthFixture(t)
	claimed, resume := make(chan struct{}), make(chan struct{})
	p, err := f.callbacks.prepare(f.owner, unusedAuthPort(t), func(event AuthCallbackReceived) error {
		close(claimed)
		<-resume
		f.events <- event
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	requestDone := make(chan error, 1)
	go func() {
		response, err := f.client.Get(p.CallbackURL + "?state=test-state")
		if err == nil {
			_, err = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
		requestDone <- err
	}()
	select {
	case <-claimed:
	case <-time.After(time.Second):
		t.Fatal("callback not claimed")
	}
	closed := make(chan struct{})
	go func() { f.callbacks.close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		close(resume)
		t.Fatal("close blocked on native event emission")
	}
	close(resume)
	if err := <-requestDone; err != nil {
		t.Fatal(err)
	}
	if event := <-f.events; event.SessionID != p.SessionID {
		t.Fatal("claimed event lost session identity")
	}
	assertAuthPortReleased(t, p.CallbackURL)
}

func TestAuthCallbackEmissionFailureConsumesSession(t *testing.T) {
	f := newAuthFixture(t)
	p, err := f.callbacks.prepare(f.owner, unusedAuthPort(t), func(AuthCallbackReceived) error { return errors.New("page unavailable") })
	if err != nil {
		t.Fatal(err)
	}
	f.arm(t, p, "test-state", time.Now().Add(time.Minute))
	f.request(t, http.MethodGet, p.CallbackURL+"?state=test-state", http.StatusGone)
	assertAuthPortReleased(t, p.CallbackURL)
	f.noEvent(t)
}
