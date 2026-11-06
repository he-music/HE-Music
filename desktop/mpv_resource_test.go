package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMpvGatewayRejectsUncontrolledSources(t *testing.T) {
	host, prefix := "127.0.0.1:34567", "/current-secret"
	for _, raw := range []string{
		"/etc/passwd", "file:///etc/passwd", "https://upstream/song.mp3",
		"http://localhost:34567/current-secret/__proxy/https://upstream/song",
		"http://127.0.0.1:34567/old-secret/__proxy/https://upstream/song",
		"http://127.0.0.1:34567/current-secret/__local/audio?path=/etc/passwd",
		"http://127.0.0.1:34567/current-secret/__api/hemusic/private",
		"http://user@127.0.0.1:34567/current-secret/__proxy/https://upstream/song",
		"http://127.0.0.1:34567/current-secret/__proxy/file:///etc/passwd",
		"http://127.0.0.1:34567/current-secret/__audio?platform=soda&url=https://upstream/song",
		"http://127.0.0.1:34567/current-secret/__proxy/https://upstream/song#fragment",
	} {
		if err := validateMpvGatewayURL(raw, host, prefix); err == nil {
			t.Fatalf("越界 URL 获准: %q", raw)
		}
	}
	for _, tail := range []string{"/__proxy/https://upstream/song.mp3?token=value", "/__audio?" + url.Values{"audio_params": {streamTestParams(t)}, "url": {"https://upstream/song"}}.Encode()} {
		if err := validateMpvGatewayURL("http://"+host+prefix+tail, host, prefix); err != nil {
			t.Fatalf("受控 URL 被拒: %v", err)
		}
	}
}

func TestMpvGatewayNetworkRangeRedirectAndManifest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/audio", http.StatusFound)
		case "/manifest":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, "#EXTM3U\nhttps://uncontrolled.invalid/private\n")
		default:
			if r.Header.Get("Range") != "bytes=2-4" {
				t.Error("Range 没有到达上游")
			}
			w.Header().Set("Content-Type", "audio/flac")
			w.Header().Set("Content-Range", "bytes 2-4/10")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "234")
		}
	}))
	defer upstream.Close()
	gateway := &NetworkGateway{host: "127.0.0.1:34567", prefix: "/secret", media: newDesktopGatewayClient()}
	registry := &mpvResourceRegistry{entries: make(map[string]*mpvResource)}
	for _, test := range []struct {
		path   string
		status int
		body   string
	}{{"/audio", 206, "234"}, {"/redirect", 206, "234"}, {"/manifest", 415, ""}} {
		resource, err := registry.create(t.Context(), t.Context(), nil, gateway, MpvLoadRequest{URL: "http://" + gateway.host + gateway.prefix + "/__proxy/" + upstream.URL + test.path})
		requireTestNoError(t, err)
		req := httptest.NewRequest("GET", resource.url, nil)
		req.Header.Set("Range", "bytes=2-4")
		response := httptest.NewRecorder()
		registry.serve(gateway, response, req, resource.token)
		if response.Code != test.status || test.body != "" && response.Body.String() != test.body || strings.Contains(response.Body.String(), "uncontrolled.invalid") || response.Header().Get("Location") != "" {
			t.Fatalf("%s: %d %q", test.path, response.Code, response.Body.String())
		}
		resource.close()
	}
}

func TestMpvLocalGatewayAuthorizationMutationAndRevoke(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "song.mp3")
	requireTestNoError(t, os.WriteFile(path, []byte("0123456789"), 0o600))
	files, owner, epoch, ref := metadataTestService(t, dir)
	gateway := &NetworkGateway{host: "127.0.0.1:34567", prefix: "/secret"}
	registry := &mpvResourceRegistry{entries: make(map[string]*mpvResource)}
	resource, err := registry.create(owner, owner, files, gateway, MpvLoadRequest{FileEpoch: epoch, LocalRef: &ref})
	requireTestNoError(t, err)
	if strings.Contains(resource.url, path) {
		t.Fatal("绝对路径泄漏给原生 URL")
	}
	req := httptest.NewRequest("GET", resource.url, nil)
	req.Header.Set("Range", "bytes=2-4")
	response := httptest.NewRecorder()
	registry.serve(gateway, response, req, resource.token)
	if response.Code != 206 || response.Body.String() != "234" {
		t.Fatalf("本地 Range: %d %q", response.Code, response.Body.String())
	}
	fixture := newMpvFixture(t)
	session := &fixture.player.session
	session.resource = resource
	release, err := registry.prepareMutation(t.Context(), files, resource.info, session)
	requireTestNoError(t, err)
	if release == nil {
		t.Fatal("写入钩子没有返回互斥释放函数")
	}
	defer release()
	if _, err := resource.file.Stat(); err == nil {
		t.Fatal("写入前文件读者没有关闭")
	}
	if session.resource != nil || !resource.lease.released.Load() {
		t.Fatal("写入前资源或租约没有释放")
	}
	requireTestNoError(t, os.Rename(path, path+".saved"))
	response = httptest.NewRecorder()
	registry.serve(gateway, response, req, resource.token)
	if response.Code != 404 {
		t.Fatal("关闭后 ticket 仍有效")
	}
}

func TestMpvResourceCloseWaitsForEveryConcurrentCloser(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	resource := &mpvResource{ctx: ctx, cancel: cancel}
	resource.readers.Add(1)
	first, second := make(chan struct{}), make(chan struct{})
	go func() { resource.close(); close(first) }()
	<-ctx.Done()
	go func() { resource.close(); close(second) }()
	select {
	case <-first:
		t.Fatal("读者尚未释放就返回")
	case <-second:
		t.Fatal("第二个 close 提前返回")
	case <-time.After(20 * time.Millisecond):
	}
	resource.readers.Done()
	for _, done := range []chan struct{}{first, second} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("关闭没有收敛")
		}
	}
}

func TestMpvResourceGrantRevokeCancelsGatewayTicket(t *testing.T) {
	dir := t.TempDir()
	requireTestNoError(t, os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("synthetic"), 0o600))
	files, owner, epoch, ref := metadataTestService(t, dir)
	registry := &mpvResourceRegistry{entries: make(map[string]*mpvResource)}
	gateway := &NetworkGateway{host: "127.0.0.1:34567", prefix: "/secret"}
	resource, err := registry.create(owner, owner, files, gateway, MpvLoadRequest{FileEpoch: epoch, LocalRef: &ref})
	requireTestNoError(t, err)
	defer resource.close()
	requireTestNoError(t, files.state.revokeDirectory(owner, epoch, ref.GrantToken))
	select {
	case <-resource.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("目录撤销没有取消原生音源")
	}
	response := httptest.NewRecorder()
	registry.serve(gateway, response, httptest.NewRequest("GET", resource.url, nil), resource.token)
	if response.Code != 404 {
		t.Fatal("撤销后的 ticket 仍能读取")
	}
}
