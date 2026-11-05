package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	controlDefaultPort        = 25666
	controlMaxID       uint64 = 9007199254740991
)

type ControlCommand struct {
	Generation uint64 `json:"generation"`
	RequestID  uint64 `json:"requestId"`
	Action     string `json:"action"`
}
type ControlSession struct {
	Generation uint64 `json:"generation"`
	Port       int    `json:"port"`
}
type controlReply struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data"`
}

// Network state is independent of native resources. emit must schedule on the
// main thread and recheck current before touching a Page. HTTP 200 means queued,
// never audio playback; only a matching renderer receipt consumes pending work.
type controlServer struct {
	mu         sync.Mutex
	dispatchMu sync.Mutex
	stopped    chan struct{}
	generation uint64
	next       uint64
	owner      context.Context
	epoch      uint64
	listener   net.Listener
	server     *http.Server
	stopOwner  func() bool
	pending    map[uint64]ControlCommand
	window     time.Time
	count      int
	emit       func(context.Context, ControlCommand) error
	appVersion string
}

func (s *controlServer) prepare(ctx context.Context, epoch uint64) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
	if ctx == nil || ctx.Err() != nil || epoch == 0 || epoch > controlMaxID || s.generation >= controlMaxID {
		return 0, errors.New("control owner unavailable")
	}
	s.generation++
	s.owner, s.epoch = ctx, epoch
	s.stopped = make(chan struct{})
	s.pending = make(map[uint64]ControlCommand)
	generation := s.generation
	s.stopOwner = context.AfterFunc(ctx, func() { s.revokeGeneration(generation) })
	return generation, nil
}

func (s *controlServer) start(generation uint64, port int) (ControlSession, error) {
	if port == 0 {
		port = controlDefaultPort
	}
	if port < 1 || port > 65535 {
		s.revokeGeneration(generation)
		return ControlSession{}, errors.New("invalid control port")
	}
	s.mu.Lock()
	valid := s.activeLocked() && s.generation == generation && s.listener == nil
	s.mu.Unlock()
	if !valid {
		return ControlSession{}, errors.New("stale control owner")
	}
	// Bind outside the UI thread. No wildcard interface or external address is accepted.
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		s.revokeGeneration(generation)
		return ControlSession{}, errors.New("control listener unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.activeLocked() || s.generation != generation || s.listener != nil {
		listener.Close()
		return ControlSession{}, errors.New("stale control owner")
	}
	s.listener = listener
	server := &http.Server{Handler: s, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 3 * time.Second, MaxHeaderBytes: 4096}
	s.server = server
	go func() { _ = server.Serve(listener) }()
	return ControlSession{Generation: generation, Port: port}, nil
}
func (s *controlServer) activeLocked() bool { return s.owner != nil && s.owner.Err() == nil }
func (s *controlServer) closeLocked() {
	if s.stopped != nil {
		close(s.stopped)
		s.stopped = nil
	}
	if s.stopOwner != nil {
		s.stopOwner()
		s.stopOwner = nil
	}
	s.owner = nil
	s.pending = nil
	s.count = 0
	s.window = time.Time{}
	if s.server != nil {
		_ = s.server.Close()
		s.server = nil
	}
	if s.listener != nil {
		_ = s.listener.Close()
		s.listener = nil
	}
}
func (s *controlServer) revoke() { s.mu.Lock(); defer s.mu.Unlock(); s.closeLocked() }
func (s *controlServer) revokeGeneration(g uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == g {
		s.closeLocked()
	}
}

func (s *controlServer) current(ctx context.Context, epoch uint64, command ControlCommand) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeLocked() && s.owner == ctx && s.epoch == epoch && s.generation == command.Generation && s.pending[command.RequestID] == command
}

func (s *controlServer) receipt(ctx context.Context, generation, requestID uint64, applied bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.activeLocked() || s.owner != ctx || s.generation != generation || requestID == 0 || s.pending[requestID].RequestID != requestID {
		return errors.New("stale control receipt")
	}
	// applied describes only that the player action resolved; it is not a promise
	// that media started. Neither accepted nor applied alters playback state here.
	delete(s.pending, requestID)
	return nil
}

func controlHost(raw string) (string, string, bool) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return "", "", false
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", "", false
	}
	value, err := strconv.Atoi(port)
	return host, port, err == nil && value > 0 && value <= 65535
}

func validControlRequest(r *http.Request, port string) bool {
	_, hostPort, ok := controlHost(r.Host)
	if !ok || hostPort != port || r.URL.IsAbs() || r.URL.RawQuery != "" || r.URL.RawPath != "" || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		return false
	}
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(peer) == nil || !net.ParseIP(peer).IsLoopback() {
		return false
	}
	for _, name := range []string{"Origin", "Sec-Fetch-Site"} {
		if len(r.Header.Values(name)) > 1 {
			return false
		}
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "none" && site != "same-origin" {
		return false
	}
	if !validControlOrigin(r.Header.Get("Origin"), r.Host) {
		return false
	}
	return true
}

func validControlOrigin(origin, host string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Scheme == "http" && u.User == nil && u.Host == host && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

func (s *controlServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	reply := func(code int, message string, data any) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(controlReply{code, message, data})
	}
	s.mu.Lock()
	port := ""
	generation := s.generation
	if s.listener != nil {
		_, port, _ = net.SplitHostPort(s.listener.Addr().String())
	}
	s.mu.Unlock()
	if !validControlRequest(r, port) {
		reply(403, "请求来源或参数无效", nil)
		return
	}
	if len(r.RequestURI) > 128 {
		reply(414, "请求过长", nil)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		reply(405, "请求方法无效", nil)
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/api/control/")
	labels := map[string]string{"play": "播放", "pause": "暂停", "toggle": "播放/暂停切换", "next": "下一曲", "prev": "上一曲"}
	label, known := labels[action]
	if r.URL.Path != "/api/control/"+action || (!known && action != "status") {
		reply(404, "接口不存在", nil)
		return
	}
	// A busy main thread must not accumulate handlers waiting on a mutex.
	// The one admitted dispatch keeps the slot until its native callback exits,
	// even when the HTTP caller has already disconnected or the owner revoked.
	if !s.dispatchMu.TryLock() {
		reply(429, "控制通道繁忙", nil)
		return
	}
	release := true
	defer func() {
		if release {
			s.dispatchMu.Unlock()
		}
	}()
	if r.Context().Err() != nil {
		return
	}
	s.mu.Lock()
	if !s.activeLocked() || generation != s.generation {
		s.mu.Unlock()
		reply(500, "主窗口未找到", nil)
		return
	}
	now := time.Now()
	if now.Sub(s.window) >= time.Second {
		s.window, s.count = now, 0
	}
	if s.count >= 32 {
		s.mu.Unlock()
		reply(429, "请求过于频繁", nil)
		return
	}
	s.count++
	if action == "status" {
		version := s.appVersion
		s.mu.Unlock()
		reply(200, "获取状态成功", map[string]any{"version": map[string]string{"app": version, "name": "HE-Music"}, "environment": map[string]string{"platform": runtime.GOOS, "arch": runtime.GOARCH, "runtime": "Go/mygo", "goVersion": runtime.Version()}, "connected": true, "window": "available"})
		return
	}
	if len(s.pending) >= 64 || s.next >= controlMaxID {
		s.mu.Unlock()
		reply(429, "待处理命令已达上限", nil)
		return
	}
	s.next++
	command := ControlCommand{Generation: s.generation, RequestID: s.next, Action: action}
	s.pending[command.RequestID] = command
	emit := s.emit
	stopped := s.stopped
	s.mu.Unlock()
	release = false
	dispatchErr := s.dispatchControl(r.Context(), command, emit, stopped)
	if dispatchErr != nil {
		s.mu.Lock()
		delete(s.pending, command.RequestID)
		s.mu.Unlock()
		reply(500, label+"失败", nil)
		return
	}
	reply(200, label+"命令已发送", nil)
}

func (s *controlServer) dispatchControl(ctx context.Context, command ControlCommand, emit func(context.Context, ControlCommand) error, stopped <-chan struct{}) error {
	result := make(chan error, 1)
	go func() {
		var err error
		if emit == nil {
			err = errors.New("control dispatch unavailable")
		} else {
			err = emit(ctx, command)
		}
		s.dispatchMu.Unlock()
		result <- err
	}()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-stopped:
		return errors.New("control owner revoked")
	}
}
