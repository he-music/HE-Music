package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGatewayActualProxyRoutesAPIAndMediaDynamically(t *testing.T) {
	desktopNetworkProxy.mu.RLock()
	old := desktopNetworkProxy.config
	desktopNetworkProxy.mu.RUnlock()
	setProxy := func(config NetworkProxyConfig) {
		desktopNetworkProxy.mu.Lock()
		desktopNetworkProxy.config = config
		desktopNetworkProxy.mu.Unlock()
	}
	defer setProxy(old)
	proxyConfig := func(raw string) NetworkProxyConfig {
		u, _ := url.Parse(raw)
		host, port, _ := net.SplitHostPort(u.Host)
		number, _ := strconv.Atoi(port)
		return NetworkProxyConfig{Protocol: "HTTP", Server: host, Port: number}
	}
	// Fake absolute-form proxies never dial their target; reserved .invalid hosts
	// ensure accidental direct requests cannot reach a real service.
	fakeProxy := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != "api.invalid" && r.Host != "media.invalid" {
				t.Errorf("unexpected target %s", r.Host)
			}
			if r.Host == "api.invalid" && r.URL.Path == "/base/cover" {
				http.Redirect(w, r, "http://media.invalid/art", http.StatusFound)
				return
			}
			if r.Host == "media.invalid" && r.Header.Get("Authorization") != "" {
				t.Error("redirect spread authorization")
			}
			fmt.Fprintf(w, "%s:%s:%s", name, r.Host, r.URL.RequestURI())
		}))
	}
	first, second := fakeProxy("first"), fakeProxy("second")
	defer first.Close()
	defer second.Close()
	_, origin := gatewayTestServer(t, gatewayConfig("http://api.invalid/base"))
	for _, item := range []struct{ proxy, name string }{{first.URL, "first"}, {second.URL, "second"}} {
		setProxy(proxyConfig(item.proxy))
		for _, route := range []string{"/__api/hemusic/cover", "/__proxy/" + gatewayTarget(t, "http://media.invalid/art")} {
			response, body := gatewayRequest(t, "GET", origin+route, "", map[string]string{"Authorization": "Bearer fixture"})
			if response.StatusCode != 200 || body != item.name+":media.invalid:/art" {
				t.Fatalf("actual proxy %d %q", response.StatusCode, body)
			}
		}
	}
	// Local APIs must bypass the active proxy, even when its configuration is bad.
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "direct") }))
	defer local.Close()
	setProxy(NetworkProxyConfig{Protocol: "HTTP", Server: "bad host", Port: 80})
	_, localOrigin := gatewayTestServer(t, gatewayConfig(local.URL))
	response, body := gatewayRequest(t, "GET", localOrigin+"/__api/hemusic/local", "", nil)
	if response.StatusCode != 200 || body != "direct" {
		t.Fatalf("local proxy bypass %d %q", response.StatusCode, body)
	}
}

func TestGatewayStreamSmallChunkAndClientDisconnect(t *testing.T) {
	cancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "x")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", origin+"/__proxy/"+gatewayTarget(t, upstream.URL), nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 1)
	if _, err = io.ReadFull(response.Body, chunk); err != nil || string(chunk) != "x" {
		t.Fatalf("small stream chunk %q %v", chunk, err)
	}
	response.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("disconnect did not cancel upstream")
	}
}

func TestGatewayManifestLimitMIMEAndAttributes(t *testing.T) {
	for _, mimeType := range []string{"application/vnd.apple.mpegurl", "application/x-mpegURL", "text/plain"} {
		t.Run(mimeType, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", mimeType)
				if r.URL.Query().Get("large") == "1" {
					_, _ = io.CopyN(w, strings.NewReader(strings.Repeat("x", gatewayManifestLimit+1)), gatewayManifestLimit+1)
					return
				}
				_, _ = io.WriteString(w, "#EXTM3U\r\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"https://cdn.invalid/i.m3u8?q=1\"\r\n#EXT-X-SESSION-KEY:URI=\"../key\"\r\nhttps://cdn.invalid/s.ts?x=1\r\n")
			}))
			defer upstream.Close()
			_, origin := gatewayTestServer(t, GatewayAPIConfig{})
			target := origin + "/__proxy/" + gatewayTarget(t, upstream.URL+"/dir/list.m3u8")
			response, body := gatewayRequest(t, "GET", target, "", nil)
			for _, raw := range []string{"https://cdn.invalid/i.m3u8?q=1", upstream.URL + "/key", "https://cdn.invalid/s.ts?x=1"} {
				if !strings.Contains(body, "/test-secret/__proxy/"+gatewayTarget(t, raw)) {
					t.Fatalf("URI not rewritten %q in %q", raw, body)
				}
			}
			if response.StatusCode != 200 || !strings.Contains(body, "\r\n") {
				t.Fatal("MIME/path detection or CRLF lost")
			}
			response, _ = gatewayRequest(t, "GET", origin+"/__proxy/"+gatewayTarget(t, upstream.URL+"/dir/list.m3u8?large=1"), "", nil)
			if response.StatusCode != 502 {
				t.Fatal("oversized manifest accepted")
			}
		})
	}
}

func TestGatewayFixedAPIEscapedPathAndUnconfigured(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, r.URL.RequestURI()) }))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL+"/base%20path?fixed=%2F"))
	response, body := gatewayRequest(t, "GET", origin+"/__api/hemusic/a%2Fb?q=%2B&target=https%3A%2F%2Fignored.invalid", "", nil)
	if response.StatusCode != 200 || body != "/base%20path/a%2Fb?fixed=%2F&q=%2B&target=https%3A%2F%2Fignored.invalid" {
		t.Fatalf("escaped target %d %q", response.StatusCode, body)
	}
	_, unconfigured := gatewayTestServer(t, GatewayAPIConfig{})
	response, _ = gatewayRequest(t, "GET", unconfigured+"/__api/hemusic/path", "", map[string]string{"Origin": "https://app.example"})
	if response.StatusCode != 503 || response.Header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("unconfigured response")
	}
}
