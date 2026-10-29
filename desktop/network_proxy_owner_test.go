package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestNetworkProxyOwnerChecksBeforeAndAfterRequest(t *testing.T) {
	p := newNetworkProxy(func(NetworkProxyConfig) error { t.Fatal("test saved settings"); return nil }, func(NetworkProxyConfig) (bool, bool, string, error) {
		t.Fatal("test applied settings")
		return false, false, "", nil
	})
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	foreign, stop := context.WithCancel(context.Background())
	defer stop()
	ready := true
	calls := 0
	denied := errors.New("owner replaced")
	authorize := func(ctx context.Context) error {
		if ctx != owner || !ready || ctx.Err() != nil {
			return denied
		}
		return nil
	}
	p.testTransport = func(NetworkProxyConfig) http.RoundTripper {
		return proxyRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			ready = false
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
		})
	}
	c := NetworkProxyConfig{Protocol: "HTTP", Server: "fake.invalid", Port: 8080}
	if _, err := p.testForOwner(foreign, c, authorize); !errors.Is(err, denied) || calls != 0 {
		t.Fatal(err, calls)
	}
	result, err := p.testForOwner(owner, c, authorize)
	if !errors.Is(err, denied) || result.Reachable || calls != 1 {
		t.Fatal(result, err, calls)
	}
	if p.config.Protocol != "off" {
		t.Fatal(p.config)
	}
}

func TestNetworkProxyTestTimeoutAndHTTPFailures(t *testing.T) {
	p := newNetworkProxy(func(NetworkProxyConfig) error { return nil }, func(NetworkProxyConfig) (bool, bool, string, error) { return true, false, "", nil })
	c := NetworkProxyConfig{Protocol: "HTTPS", Server: "fake.invalid", Port: 443}
	p.testTransport = func(NetworkProxyConfig) http.RoundTripper {
		return proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
			deadline, ok := r.Context().Deadline()
			if !ok || deadline.IsZero() {
				t.Fatal("missing bounded deadline")
			}
			return &http.Response{StatusCode: 407, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
		})
	}
	result, err := p.test(context.Background(), c)
	if err != nil || result.Reachable {
		t.Fatal(result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.testTransport = func(NetworkProxyConfig) http.RoundTripper {
		return proxyRoundTrip(func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })
	}
	if result, err = p.test(ctx, c); err == nil || result.Reachable {
		t.Fatal(result, err)
	}
}
