package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/soda"
)

const desktopGatewayMaxTarget = 64 << 10

var (
	desktopGatewayListen  = net.Listen
	desktopGateway        = &NetworkGateway{}
	desktopGatewayProcess sync.Mutex
	desktopGatewayRunning bool
)

// Bases include their deployment prefix. Resolve relative bases in the caller.
type GatewayAPIConfig struct {
	Hemusic string `json:"hemusic"`
	Netease string `json:"netease"`
	Unblock string `json:"unblock"`
}
type gatewayAPI struct {
	base   *url.URL
	client *http.Client
}
type NetworkGateway struct {
	mu     sync.RWMutex
	config GatewayAPIConfig
	apis   map[string]gatewayAPI
	media  *http.Client
	audio  *soda.AudioServer
	host   string
	prefix string
}

func init() { mygo.Bind(desktopGateway) }
func (g *NetworkGateway) Configure(ctx context.Context, config GatewayAPIConfig) error {
	return desktopLifecycle.call(ctx, false, func() error { return g.configure(config) })
}

func (g *NetworkGateway) configure(config GatewayAPIConfig) error {
	bases := map[string]*url.URL{}
	for name, raw := range map[string]string{"hemusic": config.Hemusic, "netease": config.Netease, "unblock": config.Unblock} {
		base, err := parseDesktopGatewayURL(raw)
		if err != nil {
			return errors.New("invalid gateway API base: " + name)
		}
		bases[name] = base
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.apis != nil && g.config == config {
		return nil
	}
	// A session belongs to one origin, including port. Changed configuration gets
	// fresh jars; an identical bootstrap/reload preserves the existing session.
	clients := map[string]*http.Client{}
	apis := map[string]gatewayAPI{}
	for name, base := range bases {
		origin := gatewayURLOrigin(base)
		client := clients[origin]
		if client == nil {
			client = newDesktopGatewayClient()
			client.Jar, _ = cookiejar.New(nil)
			clients[origin] = client
		}
		apis[name] = gatewayAPI{base, client}
	}
	g.closeIdleLocked()
	g.config, g.apis = config, apis
	return nil
}

func gatewayURLOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme) + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}

func (g *NetworkGateway) closeIdleLocked() {
	for _, api := range g.apis {
		api.client.CloseIdleConnections()
	}
	if g.media != nil {
		g.media.CloseIdleConnections()
	}
}

// Origin includes a secret path. Append to the whole string, keep it in memory,
// and never resolve root-relative paths against it (that would lose the secret).
func startDesktopGateway() (string, func(), error) {
	if os.Getenv("MYGO_GENERATE") != "" {
		return "", func() {}, nil
	}
	desktopGatewayProcess.Lock()
	defer desktopGatewayProcess.Unlock()
	if desktopGatewayRunning {
		return "", nil, errors.New("desktop gateway already running")
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return "", nil, err
	}
	listener, err := desktopGatewayListen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	host, prefix := listener.Addr().String(), "/"+base64.RawURLEncoding.EncodeToString(token)
	desktopGateway.mu.Lock()
	desktopGateway.host, desktopGateway.prefix = host, prefix
	desktopGateway.media = newDesktopGatewayClient()
	desktopGateway.audio = nil
	desktopGateway.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	server := &http.Server{Handler: http.HandlerFunc(desktopGateway.serveHTTP), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	desktopGatewayRunning = true
	go func() { _ = server.Serve(listener) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			shutdown, done := context.WithTimeout(context.Background(), time.Second)
			defer done()
			_ = server.Shutdown(shutdown)
			_ = server.Close()
			desktopGateway.mu.Lock()
			desktopGateway.closeIdleLocked()
			desktopGateway.mu.Unlock()
			desktopGatewayProcess.Lock()
			desktopGatewayRunning = false
			desktopGatewayProcess.Unlock()
		})
	}
	return "http://" + host + prefix, stop, nil
}

func desktopGatewayPreloadScript(origin string) string {
	return "if (!Object.prototype.hasOwnProperty.call(window, '__HE_MUSIC_GATEWAY_ORIGIN__')) Object.defineProperty(window, '__HE_MUSIC_GATEWAY_ORIGIN__', { value: " + strconv.Quote(origin) + ", configurable: false });"
}

func newDesktopGatewayClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(req *http.Request) (*url.URL, error) {
		if networkProxyDirect(req) {
			return nil, nil
		}
		desktopNetworkProxy.mu.RLock()
		config := desktopNetworkProxy.config
		desktopNetworkProxy.mu.RUnlock()
		return networkProxyURL(config)
	}
	transport.ResponseHeaderTimeout = 15 * time.Second
	transport.MaxIdleConns = 100
	transport.MaxIdleConnsPerHost = 10
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (g *NetworkGateway) serveHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.RLock()
	host, prefix, client, apis := g.host, g.prefix, g.media, g.apis
	g.mu.RUnlock()
	// Require the actual listener authority as well as the unguessable path before
	// emitting CORS. DNS names, even ones resolving to loopback, aren't accepted.
	if host == "" || r.Host != host || !strings.HasPrefix(r.URL.Path, prefix+"/") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	gatewayCORS(w.Header(), r)
	path := strings.TrimPrefix(r.URL.Path, prefix)
	if serveGatewayProbe(w, r, path) {
		return
	}
	if r.Method == "CONNECT" || r.Method == "TRACE" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if path == "/__audio" {
		g.serveAudio(w, r, client)
		return
	}
	var target *url.URL
	var err error
	apiRequest := false
	if strings.HasPrefix(path, "/__proxy/") {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "media requires GET or HEAD", http.StatusMethodNotAllowed)
			return
		}
		raw := strings.TrimPrefix(r.URL.EscapedPath(), prefix+"/__proxy/")
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			raw += "?" + r.URL.RawQuery
		}
		target, err = parseDesktopGatewayURL(raw)
	} else if after, ok := strings.CutPrefix(path, "/__api/"); ok {
		name, tail, _ := strings.Cut(after, "/")
		api, found := apis[name]
		if !found {
			http.Error(w, "API not configured", http.StatusServiceUnavailable)
			return
		}
		target = joinGatewayAPI(api.base, tail, r.URL.RawQuery)
		_, escapedTail, _ := strings.Cut(strings.TrimPrefix(r.URL.EscapedPath(), prefix+"/__api/"), "/")
		target.RawPath = strings.TrimRight(api.base.EscapedPath(), "/") + "/" + escapedTail
		client, apiRequest = api.client, true
	} else {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "invalid target", 400)
		return
	}
	if client == nil {
		http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
		return
	}
	g.forward(w, r, client, target, apiRequest, prefix)
}

func serveGatewayProbe(w http.ResponseWriter, r *http.Request, path string) bool {
	if r.Method == "OPTIONS" && r.Header.Get("Origin") != "" && r.Header.Get("Access-Control-Request-Method") != "" {
		w.Header().Add("Vary", "Access-Control-Request-Method, Access-Control-Request-Headers")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(204)
		return true
	}
	if path == "/__health" && (r.Method == "GET" || r.Method == "HEAD") {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if r.Method == "GET" {
			_, _ = w.Write([]byte("ok\n"))
		}
		return true
	}
	return false
}

func joinGatewayAPI(base *url.URL, tail, query string) *url.URL {
	target := *base
	target.Path = strings.TrimRight(base.Path, "/") + "/" + tail
	target.RawPath = ""
	target.RawQuery = base.RawQuery
	if query != "" {
		if target.RawQuery != "" {
			target.RawQuery += "&"
		}
		target.RawQuery += query
	}
	return &target
}

func gatewayCORS(header http.Header, r *http.Request) {
	// 普通图片可能先以无 Origin 的请求写入缓存，后续取色再以 CORS 模式读取。
	// 两种响应都必须声明 Vary，避免复用缺少 Allow-Origin 的缓存。
	header.Add("Vary", "Origin")
	if origin := r.Header.Get("Origin"); origin != "" {
		header.Set("Access-Control-Allow-Origin", origin)
		header.Set("Access-Control-Allow-Credentials", "true")
	}
	header.Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
	header.Set("Referrer-Policy", "no-referrer")
}

func parseDesktopGatewayURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > desktopGatewayMaxTarget {
		return nil, errors.New("invalid target length")
	}
	target, err := url.Parse(raw)
	if err != nil || target == nil {
		return nil, errors.New("invalid URL")
	}
	if target.Scheme != "http" && target.Scheme != "https" || target.Host == "" || target.Hostname() == "" || target.User != nil || target.Fragment != "" || target.Opaque != "" {
		return nil, errors.New("invalid HTTP URL")
	}
	return target, nil
}
