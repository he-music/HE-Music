package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func gatewayTarget(t *testing.T, raw string) string {
	t.Helper()
	if _, err := parseDesktopGatewayURL(raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func gatewayTestServer(t *testing.T, config GatewayAPIConfig) (*NetworkGateway, string) {
	t.Helper()
	g := &NetworkGateway{prefix: "/test-secret", media: newDesktopGatewayClient()}
	server := httptest.NewServer(http.HandlerFunc(g.serveHTTP))
	g.host = strings.TrimPrefix(server.URL, "http://")
	if config.Hemusic != "" {
		if err := g.configure(config); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { server.Close(); g.mu.Lock(); g.closeIdleLocked(); g.mu.Unlock() })
	return g, server.URL + g.prefix
}

func gatewayRequest(t *testing.T, method, target, body string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, string(data)
}
func gatewayConfig(raw string) GatewayAPIConfig { return GatewayAPIConfig{raw, raw, raw} }

func TestGatewayAPIContractCookiesAndReload(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" || strings.Contains(r.Header.Get("Cookie"), "browser=") {
			t.Errorf("browser metadata leaked: %v", r.Header)
		}
		switch r.URL.Path {
		case "/base/login":
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fixture" || r.URL.RawQuery != "fixed=1&q=2" {
				t.Errorf("API request %s %s %v", r.Method, r.URL, r.Header)
			}
			body, _ := io.ReadAll(r.Body)
			if string(body) != "payload" {
				t.Errorf("body %q", body)
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "one", Path: "/base"})
			http.SetCookie(w, &http.Cookie{Name: "restricted", Value: "yes", Path: "/private"})
			http.SetCookie(w, &http.Cookie{Name: "foreign", Value: "bad", Domain: "invalid.example", Path: "/"})
		case "/base/update":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "two", Path: "/base"})
		case "/base/logout":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "", Path: "/base", MaxAge: -1})
		default:
			_, _ = io.WriteString(w, r.Header.Get("Cookie"))
		}
	}))
	defer upstream.Close()
	separate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, r.Header.Get("Cookie")) }))
	defer separate.Close()
	config := gatewayConfig(upstream.URL + "/base?fixed=1")
	config.Netease = separate.URL
	g, origin := gatewayTestServer(t, config)
	response, _ := gatewayRequest(t, "POST", origin+"/__api/hemusic/login?q=2", "payload", map[string]string{"Authorization": "Bearer fixture", "Cookie": "browser=loopback", "Origin": "https://app.example"})
	if response.Header.Get("Set-Cookie") != "" {
		t.Fatal("upstream cookie exposed")
	}
	check := func(route, want string) {
		t.Helper()
		_, cookies := gatewayRequest(t, "GET", origin+"/__api/"+route+"/check", "", nil)
		if cookies != want {
			t.Fatalf("%s cookies %q, want %q", route, cookies, want)
		}
	}
	check("hemusic", "session=one")
	if err := g.configure(config); err != nil {
		t.Fatal(err)
	}
	check("unblock", "session=one")
	check("netease", "")
	gatewayRequest(t, "GET", origin+"/__api/hemusic/update", "", nil)
	check("hemusic", "session=two")
	gatewayRequest(t, "GET", origin+"/__api/hemusic/logout", "", nil)
	check("hemusic", "")
	gatewayRequest(t, "POST", origin+"/__api/hemusic/login?q=2", "payload", map[string]string{"Authorization": "Bearer fixture"})
	config.Unblock = separate.URL
	if err := g.configure(config); err != nil {
		t.Fatal(err)
	}
	check("hemusic", "")
}

func TestGatewayRedirectMethodsAndCredentialBoundary(t *testing.T) {
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("CDN credentials %v", r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		fmt.Fprintf(w, "%s:%s:%s", r.Method, body, r.Header.Get("Range"))
	}))
	defer cdn.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/r302", "/r303", "/r307", "/r308":
			status := map[string]int{"/r302": 302, "/r303": 303, "/r307": 307, "/r308": 308}[r.URL.Path]
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "fixture", Path: "/"})
			http.Redirect(w, r, "/end", status)
		case "/cross":
			http.Redirect(w, r, cdn.URL, http.StatusTemporaryRedirect)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		case "/invalid":
			http.Redirect(w, r, "file:///private", http.StatusFound)
		default:
			if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("Cookie") != "session=fixture" {
				t.Errorf("same origin credentials %v", r.Header)
			}
			body, _ := io.ReadAll(r.Body)
			fmt.Fprintf(w, "%s:%s", r.Method, body)
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	for _, item := range []struct{ path, want string }{{"r302", "GET:"}, {"r303", "GET:"}, {"r307", "POST:body"}, {"r308", "POST:body"}} {
		response, body := gatewayRequest(t, "POST", origin+"/__api/hemusic/"+item.path, "body", map[string]string{"Authorization": "Bearer fixture"})
		if response.StatusCode != 200 || body != item.want || response.Header.Get("Location") != "" {
			t.Fatalf("%s: %d %q", item.path, response.StatusCode, body)
		}
	}
	_, body := gatewayRequest(t, "POST", origin+"/__api/hemusic/cross", "body", map[string]string{"Authorization": "Bearer fixture", "Range": "bytes=0-2"})
	if body != "POST:body:bytes=0-2" {
		t.Fatalf("cross redirect %q", body)
	}
	for _, path := range []string{"loop", "invalid"} {
		response, _ := gatewayRequest(t, "GET", origin+"/__api/hemusic/"+path, "", nil)
		if response.StatusCode != 502 {
			t.Fatalf("redirect %s status %d", path, response.StatusCode)
		}
	}
}

func TestGatewayMediaRangeRedirectAndHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("media credentials %v", r.Header)
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/audio", http.StatusFound)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://evil.example")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Connection", "X-Secret")
		w.Header().Set("X-Secret", "hop")
		w.Header().Set("Accept-Ranges", "bytes")
		if r.Header.Get("Range") == "bytes=99-" {
			w.Header().Set("Content-Range", "bytes */4")
			w.WriteHeader(416)
			return
		}
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.Header().Set("Content-Length", "4")
		w.WriteHeader(206)
		if r.Method != "HEAD" {
			_, _ = io.WriteString(w, "data")
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	target := origin + "/__proxy/" + gatewayTarget(t, upstream.URL+"/redirect")
	for _, method := range []string{"GET", "HEAD"} {
		response, body := gatewayRequest(t, method, target, "", map[string]string{"Range": "bytes=0-3", "Authorization": "fixture", "Cookie": "session=fixture", "Origin": "https://app.example"})
		if response.StatusCode != 206 || response.Header.Get("Content-Range") != "bytes 0-3/4" || response.Header.Get("Access-Control-Allow-Origin") != "https://app.example" || response.Header.Get("Access-Control-Allow-Private-Network") != "" || response.Header.Get("X-Secret") != "" {
			t.Fatalf("response %d %v", response.StatusCode, response.Header)
		}
		if method == "GET" && body != "data" || method == "HEAD" && body != "" {
			t.Fatalf("body %q", body)
		}
	}
	response, _ := gatewayRequest(t, "GET", target, "", map[string]string{"Range": "bytes=99-"})
	if response.StatusCode != 416 || response.Header.Get("Content-Range") != "bytes */4" {
		t.Fatal("416 lost")
	}
}

func TestGatewayHLSFinalBaseAndResources(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/hls/main.m3u8?token=fixture", http.StatusFound)
			return
		}
		if r.URL.Path == "/audio.m3u8" {
			_, _ = io.WriteString(w, "#EXTM3U\n")
			return
		}
		if r.URL.Path != "/hls/main.m3u8" {
			_, _ = io.WriteString(w, r.URL.RequestURI())
			return
		}
		w.Header().Set("Content-Type", "application/x-mpegURL")
		w.Header().Set("ETag", "old")
		if r.Header.Get("Range") != "" {
			w.WriteHeader(206)
			return
		}
		_, _ = io.WriteString(w, "#EXTM3U\n#comment stays\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?k=1\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"/audio.m3u8\"\n#EXT-X-SESSION-KEY:URI=\"data:text/plain;base64,AAAA\"\nseg.ts?q=2\n")
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	target := origin + "/__proxy/" + gatewayTarget(t, upstream.URL+"/start")
	response, body := gatewayRequest(t, "GET", target, "", nil)
	if response.StatusCode != 200 || response.Header.Get("ETag") != "" || !strings.Contains(body, "#comment stays") || !strings.Contains(body, "data:text/plain;base64,AAAA") {
		t.Fatalf("manifest %d %q", response.StatusCode, body)
	}
	for _, path := range []string{"/hls/key?k=1", "/hls/init.mp4", "/audio.m3u8", "/hls/seg.ts?q=2"} {
		rewritten := "/test-secret/__proxy/" + gatewayTarget(t, upstream.URL+path)
		if !strings.Contains(body, rewritten) {
			t.Fatalf("missing rewritten resource %s in %q", path, body)
		}
		_, data := gatewayRequest(t, "GET", strings.TrimSuffix(origin, "/test-secret")+rewritten, "", nil)
		want := path
		if strings.HasSuffix(path, ".m3u8") {
			want = "#EXTM3U\n"
		}
		if data != want {
			t.Fatalf("resource chain %q", data)
		}
	}
	response, _ = gatewayRequest(t, "GET", target, "", map[string]string{"Range": "bytes=0-3"})
	if response.StatusCode != 502 {
		t.Fatal("partial manifest accepted")
	}
	base, _ := url.Parse(upstream.URL)
	if _, err := rewriteGatewayManifest("#EXTM3U\n#EXT-X-KEY:URI=\"file:///private\"", base, "/token"); err == nil {
		t.Fatal("non HTTP key accepted")
	}
}

func TestGatewaySecretCORSAndOptions(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, r.Method) }))
	defer upstream.Close()
	g, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	headers := map[string]string{"Origin": "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, range"}
	response, _ := gatewayRequest(t, "OPTIONS", origin+"/__api/hemusic/path", "", headers)
	if response.StatusCode != 204 || response.Header.Get("Access-Control-Allow-Headers") != "authorization, range" {
		t.Fatal("preflight failed")
	}
	_, body := gatewayRequest(t, "OPTIONS", origin+"/__api/hemusic/path", "", map[string]string{"Origin": "https://app.example"})
	if body != "OPTIONS" {
		t.Fatal("ordinary OPTIONS swallowed")
	}
	response, _ = gatewayRequest(t, "GET", origin+"/__proxy/invalid", "", headers)
	if response.StatusCode != 400 || response.Header.Get("Access-Control-Allow-Origin") != "https://app.example" || response.Header.Get("Access-Control-Expose-Headers") == "" {
		t.Fatal("error unreadable")
	}
	for _, path := range []string{"/__health", "/wrong/__health"} {
		response, _ = gatewayRequest(t, "GET", strings.TrimSuffix(origin, g.prefix)+path, "", headers)
		if response.StatusCode != 403 || response.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("missing secret accepted")
		}
	}
	request := httptest.NewRequest("GET", origin+"/__health", nil)
	request.Host = "rebind.example"
	recorder := httptest.NewRecorder()
	g.serveHTTP(recorder, request)
	if recorder.Code != 403 {
		t.Fatal("rebound Host accepted")
	}
	for _, raw := range []string{"/api", "ftp://host", "https://user:password@host", "http://host/#fragment"} {
		if err := g.configure(gatewayConfig(raw)); err == nil {
			t.Fatalf("base accepted %s", raw)
		}
	}
}

func TestGatewayStopCancellationGenerationAndDuplicateStart(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer upstream.Close()
	origin, stop, err := startDesktopGateway()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if _, _, err := startDesktopGateway(); err == nil {
		t.Fatal("duplicate start accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", origin+"/__proxy/"+gatewayTarget(t, upstream.URL), nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	<-started
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not finish")
	}
	oldListen := desktopGatewayListen
	defer func() { desktopGatewayListen = oldListen }()
	desktopGatewayListen = func(string, string) (net.Listener, error) {
		t.Error("generation listened")
		return nil, fmt.Errorf("unexpected listen")
	}
	t.Setenv("MYGO_GENERATE", "1")
	generated, noop, err := startDesktopGateway()
	if err != nil || generated != "" || noop == nil {
		t.Fatal("generation contract")
	}
	noop()
}

func TestGatewayProxyLoopbackAndDynamicConfig(t *testing.T) {
	desktopNetworkProxy.mu.Lock()
	old := desktopNetworkProxy.config
	desktopNetworkProxy.mu.Unlock()
	defer func() {
		desktopNetworkProxy.mu.Lock()
		desktopNetworkProxy.config = old
		desktopNetworkProxy.mu.Unlock()
	}()
	client := newDesktopGatewayClient()
	defer client.CloseIdleConnections()
	transport := client.Transport.(*http.Transport)
	for _, config := range []NetworkProxyConfig{{Protocol: "HTTP", Server: "127.0.0.1", Port: 8080}, {Protocol: "off"}, {Protocol: "HTTPS", Server: "proxy.example", Port: 8443}} {
		desktopNetworkProxy.mu.Lock()
		desktopNetworkProxy.config = config
		desktopNetworkProxy.mu.Unlock()
		proxy, err := transport.Proxy(httptest.NewRequest("GET", "https://public.example", nil))
		if err != nil || config.Protocol == "off" && proxy != nil || config.Protocol != "off" && (proxy == nil || proxy.Hostname() != config.Server) {
			t.Fatalf("dynamic proxy %v %v", proxy, err)
		}
		for _, raw := range []string{"http://127.0.0.1", "http://localhost", "http://[::1]"} {
			proxy, err := transport.Proxy(httptest.NewRequest("GET", raw, nil))
			if proxy != nil || err != nil {
				t.Fatal("loopback proxied")
			}
		}
	}
}

func TestGatewayAPIBodyLimit(t *testing.T) {
	for _, length := range []int64{-1, 5} {
		if _, err := readGatewayAPIBody(strings.NewReader("12345"), length, 4); !errors.Is(err, errGatewayBodyLimit) {
			t.Fatalf("length %d error %v", length, err)
		}
	}
	if data, err := readGatewayAPIBody(strings.NewReader("1234"), 4, 4); err != nil || string(data) != "1234" {
		t.Fatal("boundary rejected")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("oversized request reached upstream") }))
	defer upstream.Close()
	g, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	req := httptest.NewRequest("POST", origin+"/__api/hemusic/upload", strings.NewReader("small"))
	req.ContentLength = gatewayAPIBodyLimit + 1
	recorder := httptest.NewRecorder()
	g.serveHTTP(recorder, req)
	if recorder.Code != 413 {
		t.Fatalf("limit status %d", recorder.Code)
	}
}
