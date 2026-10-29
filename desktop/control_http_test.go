package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func controlFixture(t *testing.T) (*controlServer, context.Context, *httptest.Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s := &controlServer{appVersion: "1.0.4", emit: func(context.Context, ControlCommand) error { return nil }}
	if _, err := s.prepare(ctx, 1); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(s)
	s.listener = server.Listener
	server.Start()
	t.Cleanup(func() { cancel(); s.revoke(); server.Close() })
	return s, ctx, server
}
func controlRequest(s *controlServer, method, path string, change func(*http.Request)) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	request.Host = s.listener.Addr().String()
	request.RemoteAddr = "127.0.0.1:1234"
	if change != nil {
		change(request)
	}
	reply := httptest.NewRecorder()
	s.ServeHTTP(reply, request)
	return reply
}
func TestControlLegacyRoutesAndReceipts(t *testing.T) {
	s, ctx, _ := controlFixture(t)
	var events []ControlCommand
	s.emit = func(_ context.Context, c ControlCommand) error { events = append(events, c); return nil }
	for _, action := range []string{"play", "pause", "toggle", "next", "prev"} {
		response := controlRequest(s, "GET", "/api/control/"+action, nil)
		if response.Code != 200 || !strings.Contains(response.Body.String(), "命令已发送") {
			t.Fatal(response)
		}
		c := events[len(events)-1]
		if c.Action != action || !s.current(ctx, 1, c) {
			t.Fatal(c)
		}
		if err := s.receipt(ctx, c.Generation, c.RequestID, true); err != nil {
			t.Fatal(err)
		}
		if err := s.receipt(ctx, c.Generation, c.RequestID, true); err == nil {
			t.Fatal("duplicate receipt")
		}
	}
	response := controlRequest(s, "GET", "/api/control/status", nil)
	var result struct {
		Data struct {
			Environment map[string]string
			Connected   bool
			Window      string
			Version     map[string]string
		}
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || !result.Data.Connected || result.Data.Window != "available" || result.Data.Version["app"] != "1.0.4" || result.Data.Environment["runtime"] != "Go/mygo" {
		t.Fatal(response.Body.String())
	}
	for _, key := range []string{"nodeVersion", "electronVersion", "chromeVersion", "v8Version"} {
		if _, ok := result.Data.Environment[key]; ok {
			t.Fatal(key)
		}
	}
}
func TestControlRejectsInvalidRequests(t *testing.T) {
	s, _, _ := controlFixture(t)
	cases := []struct {
		name, method, path string
		change             func(*http.Request)
		code               int
	}{
		{"method", "POST", "/api/control/play", nil, 405},
		{"route", "GET", "/control/play", nil, 404},
		{"unknown", "GET", "/api/control/open-file", nil, 404},
		{"query", "GET", "/api/control/play?path=/private/music", nil, 403},
		{"encoded", "GET", "/api/control/%70lay", nil, 403},
		{"host", "GET", "/api/control/play", func(r *http.Request) { r.Host = "evil.test:25666" }, 403},
		{"port", "GET", "/api/control/play", func(r *http.Request) { r.Host = "127.0.0.1:1" }, 403},
		{"remote", "GET", "/api/control/play", func(r *http.Request) { r.RemoteAddr = "192.0.2.1:2" }, 403},
		{"origin", "GET", "/api/control/play", func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, 403},
		{"null-origin", "GET", "/api/control/play", func(r *http.Request) { r.Header.Set("Origin", "null") }, 403},
		{"cross-site", "GET", "/api/control/play", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"same-site", "GET", "/api/control/play", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") }, 403},
		{"multi-origin", "GET", "/api/control/play", func(r *http.Request) {
			r.Header.Add("Origin", "http://"+r.Host)
			r.Header.Add("Origin", "http://evil.test")
		}, 403},
		{"body", "GET", "/api/control/play", func(r *http.Request) { r.ContentLength = 1 }, 403},
		{"chunked", "GET", "/api/control/play", func(r *http.Request) { r.TransferEncoding = []string{"chunked"} }, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if r := controlRequest(s, tc.method, tc.path, tc.change); r.Code != tc.code {
				t.Fatalf("got %d: %s", r.Code, r.Body.String())
			}
		})
	}
	if r := controlRequest(s, "GET", "/api/control/status", func(r *http.Request) {
		r.Header.Set("Origin", "http://"+r.Host)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}); r.Code != 200 {
		t.Fatal(r.Code)
	}
}
func TestControlLimitsAndDispatchFailure(t *testing.T) {
	s, _, _ := controlFixture(t)
	s.emit = func(context.Context, ControlCommand) error { return errors.New("/private/secret") }
	response := controlRequest(s, "GET", "/api/control/play", nil)
	if response.Code != 500 || strings.Contains(response.Body.String(), "secret") || len(s.pending) != 0 {
		t.Fatal(response.Body.String())
	}
	s.emit = func(context.Context, ControlCommand) error { return nil }
	s.count = 0
	for i := 0; i < 32; i++ {
		if r := controlRequest(s, "GET", "/api/control/play", nil); r.Code != 200 {
			t.Fatal(i, r.Code)
		}
	}
	if r := controlRequest(s, "GET", "/api/control/play", nil); r.Code != 429 {
		t.Fatal(r.Code)
	}
	s.count = 0
	s.window = time.Now().Add(-2 * time.Second)
	for i := 0; i < 32; i++ {
		if r := controlRequest(s, "GET", "/api/control/play", nil); r.Code != 200 {
			t.Fatal(i, r.Code)
		}
	}
	s.count = 0
	if r := controlRequest(s, "GET", "/api/control/play", nil); r.Code != 429 {
		t.Fatal("pending limit", r.Code)
	}
}
func TestControlOwnerReplacementAndLateReceipt(t *testing.T) {
	s, ctx, _ := controlFixture(t)
	controlRequest(s, "GET", "/api/control/play", nil)
	old := s.pending[1]
	newer, cancel := context.WithCancel(context.Background())
	defer cancel()
	generation, err := s.prepare(newer, 2)
	if err != nil {
		t.Fatal(err)
	}
	if s.current(ctx, 1, old) || s.receipt(ctx, old.Generation, old.RequestID, true) == nil || s.receipt(newer, generation, old.RequestID, false) == nil {
		t.Fatal("old owner accepted")
	}
	s.revokeGeneration(old.Generation)
	if !s.activeLocked() {
		t.Fatal("old revoke killed new owner")
	}
	s.revoke()
	if _, err := s.start(generation, 0); err == nil {
		t.Fatal("revoked startup")
	}
}
func TestControlListenerCloseAndCancellation(t *testing.T) {
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, rawPort, _ := net.SplitHostPort(probe.Addr().String())
	port, _ := strconv.Atoi(rawPort)
	probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s := &controlServer{emit: func(context.Context, ControlCommand) error { return nil }}
	generation, err := s.prepare(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.start(generation, port)
	if err != nil {
		t.Fatal(err)
	}
	defer s.revoke()
	if status.Port != port {
		t.Fatal(status)
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		closed := s.listener == nil
		s.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel leaked listener")
		}
		time.Sleep(time.Millisecond)
	}
	replacement, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", rawPort))
	if err != nil {
		t.Fatal("port not released", err)
	}
	replacement.Close()
	if _, err := s.start(generation, -1); err == nil {
		t.Fatal("invalid port")
	}
}

func TestControlConcurrentDispatchIsOrdered(t *testing.T) {
	s, _, _ := controlFixture(t)
	var events []ControlCommand
	s.emit = func(_ context.Context, command ControlCommand) error { events = append(events, command); return nil }
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Go(func() {
			response := controlRequest(s, "GET", "/api/control/toggle", nil)
			if response.Code != 200 && response.Code != 429 {
				t.Errorf("dispatch: %d", response.Code)
			}
		})
	}
	workers.Wait()
	if len(events) < 1 || len(events) > 16 {
		t.Fatal(len(events))
	}
	for i, event := range events {
		if event.RequestID != uint64(i+1) {
			t.Fatal("out-of-order event", event)
		}
	}
}
func TestControlRealHTTPStatusAndUnavailableOwner(t *testing.T) {
	s, _, server := controlFixture(t)
	response, err := server.Client().Get(server.URL + "/api/control/status")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	s.mu.Lock()
	s.owner = nil
	s.mu.Unlock()
	if r := controlRequest(s, "GET", "/api/control/play", nil); r.Code != 500 || !strings.Contains(r.Body.String(), "主窗口未找到") {
		t.Fatal(r.Body.String())
	}
}
func TestControlRevokeWhileDispatchWaitsRejectsOldCommand(t *testing.T) {
	s, ctx, _ := controlFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	s.emit = func(_ context.Context, command ControlCommand) error {
		close(entered)
		<-release
		if s.current(ctx, 1, command) {
			return nil
		}
		return errors.New("revoked dispatch")
	}
	result := make(chan int, 1)
	go func() { result <- controlRequest(s, "GET", "/api/control/play", nil).Code }()
	<-entered
	s.revoke()
	select {
	case code := <-result:
		if code != 500 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("dispatch or revoke blocked")
	}
	close(release)
}

// Real loopback HTTP exercises disconnected clients as well as handler exit;
// the fake UI remains blocked independently of the request context.
func TestControlBusyAdmissionDisconnectAndRevoke(t *testing.T) {
	for _, reason := range []string{"disconnect", "revoke"} {
		t.Run(reason, func(t *testing.T) {
			owner, cancelOwner := context.WithCancel(context.Background())
			defer cancelOwner()
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unblock()
			var emits, delivered atomic.Int32
			s := &controlServer{}
			s.emit = func(request context.Context, command ControlCommand) error {
				emits.Add(1)
				close(entered)
				<-release
				if request.Err() != nil || !s.current(owner, 1, command) {
					return errors.New("stale dispatch")
				}
				delivered.Add(1)
				return nil
			}
			if _, err := s.prepare(owner, 1); err != nil {
				t.Fatal(err)
			}
			handlerDone := make(chan struct{}, 128)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				s.ServeHTTP(w, r)
				handlerDone <- struct{}{}
			}))
			s.listener = server.Listener
			server.Start()
			defer server.Close()
			defer s.revoke()
			// Ensure failure cleanup releases fake UI before closing httptest's server.
			defer unblock()
			client := server.Client()
			client.Timeout = time.Second
			requestCtx, cancelRequest := context.WithCancel(context.Background())
			defer cancelRequest()
			request, err := http.NewRequestWithContext(requestCtx, "GET", server.URL+"/api/control/play", nil)
			if err != nil {
				t.Fatal(err)
			}
			firstDone := make(chan struct{}, 1)
			go func() {
				response, _ := client.Do(request)
				if response != nil {
					response.Body.Close()
				}
				firstDone <- struct{}{}
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("first emit did not start")
			}
			var burst sync.WaitGroup
			for i := 0; i < 64; i++ {
				burst.Go(func() {
					response, err := client.Get(server.URL + "/api/control/pause")
					if err != nil {
						t.Error(err)
						return
					}
					defer response.Body.Close()
					if response.StatusCode != 429 {
						t.Errorf("busy dispatch: %d", response.StatusCode)
					}
				})
			}
			burstDone := make(chan struct{})
			go func() { burst.Wait(); close(burstDone) }()
			select {
			case <-burstDone:
			case <-time.After(2 * time.Second):
				t.Fatal("burst handlers waited behind emit")
			}
			if emits.Load() != 1 {
				t.Fatal("unbounded emit admission", emits.Load())
			}
			// Drain every completed busy response, leaving only the first handler.
			for i := 0; i < 64; i++ {
				select {
				case <-handlerDone:
				case <-time.After(time.Second):
					t.Fatal("busy handler retained")
				}
			}
			if reason == "disconnect" {
				cancelRequest()
			} else {
				s.revoke()
			}
			select {
			case <-handlerDone:
			case <-time.After(time.Second):
				t.Fatal("cancel/revoke did not release handler")
			}
			select {
			case <-firstDone:
			case <-time.After(time.Second):
				t.Fatal("first HTTP client retained")
			}
			s.mu.Lock()
			pending := len(s.pending)
			s.mu.Unlock()
			if pending != 0 {
				t.Fatal("cancel retained pending request", pending)
			}
			// Admission stays bounded while an uncancellable native callback is queued.
			if s.dispatchMu.TryLock() {
				s.dispatchMu.Unlock()
				t.Fatal("slot released before blocked UI callback exited")
			}
			unblock()
			deadline := time.Now().Add(time.Second)
			for !s.dispatchMu.TryLock() {
				if time.Now().After(deadline) {
					t.Fatal("dispatch slot leaked")
				}
				time.Sleep(time.Millisecond)
			}
			s.dispatchMu.Unlock()
			if delivered.Load() != 0 {
				t.Fatal("late control delivered after cancel/revoke")
			}
			if reason == "disconnect" {
				s.emit = func(context.Context, ControlCommand) error { return nil }
				response, err := client.Get(server.URL + "/api/control/pause")
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != 200 {
					t.Fatal("dispatch slot not reusable", response.StatusCode)
				}
			}
		})
	}
}
