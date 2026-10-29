package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func gatewayTarget(t *testing.T, raw string) string {
	t.Helper()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func TestDecodeDesktopGatewayTarget(t *testing.T) {
	valid, err := decodeDesktopGatewayTarget(gatewayTarget(t, "https://music.example/song?a=1"))
	if err != nil || valid.String() != "https://music.example/song?a=1" {
		t.Fatalf("valid target = %v, %v", valid, err)
	}
	for _, raw := range []string{"", "ftp://music.example", "https:///missing-host", "https://user:pass@music.example", "https://music.example/#fragment", "https://music.example/%zz"} {
		if _, err := decodeDesktopGatewayTarget(gatewayTarget(t, raw)); err == nil {
			t.Errorf("target %q was accepted", raw)
		}
	}
	if _, err := decodeDesktopGatewayTarget("not-base64"); err == nil {
		t.Error("invalid base64 was accepted")
	}
}

func TestDesktopGatewayOptionsAndCORS(t *testing.T) {
	handler := newDesktopGatewayHandler(nil)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodOptions, "/__proxy", nil)
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("Access-Control-Request-Headers", "authorization, range")
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || recorder.Header().Get("Access-Control-Allow-Origin") != "https://app.example" || recorder.Header().Get("Access-Control-Allow-Headers") != "authorization, range" {
		t.Fatalf("preflight response: %d %v", recorder.Code, recorder.Header())
	}
}

func TestDesktopGatewayForwardsRequestAndResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test" || r.Header.Get("Origin") != "" {
			t.Errorf("forwarded request = %s, headers=%v", r.Method, r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(body)
	}))
	defer upstream.Close()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/__proxy?target="+url.QueryEscape(gatewayTarget(t, upstream.URL+"/audio")), strings.NewReader("data"))
	request.Header.Set("Authorization", "Bearer test")
	request.Header.Set("Origin", "https://app.example")
	newDesktopGatewayHandler(upstream.Client()).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "data" || recorder.Header().Get("Content-Range") != "bytes 0-3/4" {
		t.Fatalf("gateway response: %d %q %v", recorder.Code, recorder.Body.String(), recorder.Header())
	}
	if recorder.Header().Get("Access-Control-Allow-Origin") != "https://app.example" || recorder.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("CORS response: %v", recorder.Header())
	}
}

func TestDesktopGatewayCancellation(t *testing.T) {
	started := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer upstream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/__proxy?target="+url.QueryEscape(gatewayTarget(t, upstream.URL)), nil).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		newDesktopGatewayHandler(upstream.Client()).ServeHTTP(recorder, request)
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("gateway did not observe cancellation")
	}
}

func TestStartDesktopGateway(t *testing.T) {
	origin, stop, err := startDesktopGateway()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	response, err := http.Get(origin + "/__health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", response.StatusCode)
	}
}

func TestDesktopGatewayClientProxyReadsCurrentConfig(t *testing.T) {
	old := desktopNetworkProxy.config
	defer func() { desktopNetworkProxy.config = old }()
	client := newDesktopGatewayClient()
	transport := client.Transport.(*http.Transport)
	desktopNetworkProxy.config = NetworkProxyConfig{Protocol: "off"}
	proxy, err := transport.Proxy(httptest.NewRequest(http.MethodGet, "https://example.com", nil))
	if err != nil || proxy != nil {
		t.Fatalf("off proxy = %v, %v", proxy, err)
	}
	desktopNetworkProxy.config = NetworkProxyConfig{Protocol: "HTTP", Server: "bad host", Port: 8080}
	if _, err := transport.Proxy(httptest.NewRequest(http.MethodGet, "https://example.com", nil)); !errors.Is(err, errNetworkProxyConfig) {
		t.Fatalf("proxy config error = %v", err)
	}
}
