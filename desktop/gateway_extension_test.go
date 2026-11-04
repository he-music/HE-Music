package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayPathTargetPreservesEscapingRangeAndHeaders(t *testing.T) {
	const escapedPath = "/music/%E6%AD%8C/a%2Fb.FLAC"
	const query = "target=ordinary-upstream-value&signature=a%2Bb&part=1&part=2&empty="
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != escapedPath || r.URL.RawQuery != query {
			t.Errorf("target changed: %s", r.URL.RequestURI())
		}
		if r.Header.Get("Range") != "bytes=0-3" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("unexpected forwarded headers: %v", r.Header)
		}
		w.Header().Set("Content-Type", "audio/x-flac")
		w.Header().Set("Content-Length", "4")
		w.Header().Set("Content-Range", "bytes 0-3/100")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		if r.Method != "HEAD" {
			_, _ = io.WriteString(w, "fLaC")
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	target := origin + "/__proxy/" + upstream.URL + escapedPath + "?" + query
	for _, method := range []string{"GET", "HEAD"} {
		response, body := gatewayRequest(t, method, target, "", map[string]string{"Range": "bytes=0-3", "Authorization": "private", "Cookie": "private"})
		if response.StatusCode != http.StatusPartialContent || response.Header.Get("Content-Type") != "audio/x-flac" || response.Header.Get("Content-Length") != "4" || response.Header.Get("Content-Range") != "bytes 0-3/100" || response.Header.Get("Accept-Ranges") != "bytes" {
			t.Fatalf("%s: %d %v", method, response.StatusCode, response.Header)
		}
		if method == "GET" && body != "fLaC" || method == "HEAD" && body != "" {
			t.Fatalf("unexpected body: %q", body)
		}
	}
}

func TestGatewayPathTargetRetainsMethodAndURLValidation(t *testing.T) {
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	for _, test := range []struct {
		method, route string
		status        int
	}{
		{"POST", "/__proxy/https://media.invalid/audio.flac", 405},
		{"GET", "/__proxy/invalid", 400},
		{"GET", "/__proxy/file:///private/audio.flac", 400},
		{"GET", "/__proxy/https://user:pass@media.invalid/audio.flac", 400},
		{"GET", "/__proxy/?target=https://media.invalid/audio.flac", 400},
		{"GET", "/__proxy?target=https://media.invalid/audio.flac", 404},
		{"GET", "/__proxy/media.flac?target=https://media.invalid/audio.flac", 400},
	} {
		response, _ := gatewayRequest(t, test.method, origin+test.route, "", nil)
		if response.StatusCode != test.status {
			t.Errorf("%s %s: got %d, want %d", test.method, test.route, response.StatusCode, test.status)
		}
	}
}
