package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayCORSCacheVariants(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://upstream.invalid")
		w.Header().Set("Access-Control-Allow-Credentials", "false")
		w.Header().Set("Cache-Control", "max-age=2592000")
		w.Header().Set("Vary", "Accept-Encoding")
		if r.URL.Path == "/manifest.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprint(w, "#EXTM3U\n#EXTINF:1,\nsegment.ts\n")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		if r.Header.Get("Range") != "" {
			w.Header().Set("Content-Range", "bytes 0-3/4")
			w.WriteHeader(http.StatusPartialContent)
		}
		fmt.Fprint(w, "data")
	}))
	defer upstream.Close()
	_, base := gatewayTestServer(t, gatewayConfig(upstream.URL))
	for _, test := range []struct {
		name, route string
		status      int
	}{
		{"media", "/__proxy/" + upstream.URL + "/cover.jpg", http.StatusOK},
		{"manifest", "/__proxy/" + upstream.URL + "/manifest.m3u8", http.StatusOK},
		{"hemusic", "/__api/hemusic/cover.jpg", http.StatusOK},
		{"netease", "/__api/netease/cover.jpg", http.StatusOK},
		{"unblock", "/__api/unblock/cover.jpg", http.StatusOK},
		{"health", "/__health", http.StatusOK},
		{"invalid-media", "/__proxy/invalid", http.StatusBadRequest},
		{"invalid-audio", "/__audio", http.StatusBadRequest},
		{"missing-api", "/__api/missing/cover.jpg", http.StatusServiceUnavailable},
		{"missing-route", "/missing", http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			// 普通图片先加载，再由取色/Canvas 跨域读取同一 URL；两种响应必须区分缓存。
			for _, origin := range []string{"", "http://127.0.0.1:14667", "mygo://app", "null"} {
				response, _ := gatewayRequest(t, http.MethodGet, base+test.route, "", map[string]string{"Origin": origin})
				if response.StatusCode != test.status {
					t.Fatalf("origin %q: status %d, want %d", origin, response.StatusCode, test.status)
				}
				assertGatewayCORS(t, response.Header, origin)
				if test.name == "media" {
					assertGatewayVary(t, response.Header, "Accept-Encoding")
					if response.Header.Get("Cache-Control") != "max-age=2592000" {
						t.Fatal("media cache policy was lost")
					}
				}
			}
		})
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response, _ := gatewayRequest(t, method, base+"/__proxy/"+upstream.URL+"/cover.jpg", "", map[string]string{
			"Origin": "http://127.0.0.1:14667", "Range": "bytes=0-3",
		})
		if response.StatusCode != http.StatusPartialContent || response.Header.Get("Content-Range") != "bytes 0-3/4" {
			t.Fatalf("%s range response: %d %v", method, response.StatusCode, response.Header)
		}
		assertGatewayCORS(t, response.Header, "http://127.0.0.1:14667")
	}
}

func TestGatewayCORSPreflightRoutes(t *testing.T) {
	_, base := gatewayTestServer(t, GatewayAPIConfig{})
	for _, route := range []string{"/__proxy/https://media.invalid/cover.jpg", "/__api/hemusic/path", "/__api/netease/path", "/__api/unblock/path", "/__audio", "/__health"} {
		t.Run(route, func(t *testing.T) {
			for _, requestedHeaders := range []string{"authorization, content-type", "range, if-range", "x-client-instance-id"} {
				response, _ := gatewayRequest(t, http.MethodOptions, base+route, "", map[string]string{
					"Origin": "http://127.0.0.1:14667", "Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": requestedHeaders,
				})
				if response.StatusCode != http.StatusNoContent || response.Header.Get("Access-Control-Allow-Headers") != requestedHeaders {
					t.Fatalf("preflight response: %d %v", response.StatusCode, response.Header)
				}
				assertGatewayCORS(t, response.Header, "http://127.0.0.1:14667")
				assertGatewayVary(t, response.Header, "Access-Control-Request-Method")
				assertGatewayVary(t, response.Header, "Access-Control-Request-Headers")
				if !strings.Contains(response.Header.Get("Access-Control-Allow-Methods"), "GET") {
					t.Fatal("preflight did not allow requested method")
				}
			}
		})
	}
}

func assertGatewayCORS(t *testing.T, header http.Header, origin string) {
	t.Helper()
	if values := header.Values("Access-Control-Allow-Origin"); origin == "" && len(values) != 0 || origin != "" && (len(values) != 1 || values[0] != origin) {
		t.Fatalf("origin %q: allow origins %v", origin, values)
	}
	if origin != "" && header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("origin %q: credentials not allowed", origin)
	}
	if header.Get("Access-Control-Expose-Headers") != "Content-Length, Content-Range, Accept-Ranges, X-Client-Instance-ID" {
		t.Fatal("media response headers not exposed")
	}
	assertGatewayVary(t, header, "Origin")
}

func assertGatewayVary(t *testing.T, header http.Header, name string) {
	t.Helper()
	for _, value := range header.Values("Vary") {
		for token := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), name) {
				return
			}
		}
	}
	t.Fatalf("Vary does not include %s: %v", name, header.Values("Vary"))
}
