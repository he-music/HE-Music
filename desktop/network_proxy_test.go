package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/he-music/HE-Music/desktop/internal/httpclient"
)

func TestNetworkProxyValidation(t *testing.T) {
	for _, host := range []string{"host/path", "user@host", "host --flag", "https://host", "-flag", "host\n", "a..b", "[::1]"} {
		if _, err := networkProxyURL(NetworkProxyConfig{Protocol: "HTTP", Server: host, Port: 8080}); err == nil {
			t.Errorf("accepted %q", host)
		}
	}
	for _, host := range []string{"localhost", "proxy.example", "127.0.0.1", "::1"} {
		if _, err := networkProxyURL(NetworkProxyConfig{Protocol: "HTTPS", Server: host, Port: 443}); err != nil {
			t.Errorf("rejected %q: %v", host, err)
		}
	}
	if u, err := networkProxyURL(NetworkProxyConfig{Protocol: "off"}); err != nil || u != nil {
		t.Fatal(u, err)
	}
	for _, c := range []NetworkProxyConfig{{Protocol: "SOCKS", Server: "host", Port: 1}, {Protocol: "HTTP", Server: "host", Port: 0}, {Protocol: "HTTP", Server: "host", Port: 65536}} {
		if _, err := networkProxyURL(c); err == nil {
			t.Fatal("accepted invalid config")
		}
	}
}

type proxyRoundTrip func(*http.Request) (*http.Response, error)

func (f proxyRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestNetworkProxyTestIsIsolated(t *testing.T) {
	saved, applied := 0, 0
	p := newNetworkProxy(func(NetworkProxyConfig) error { saved++; return nil }, func(NetworkProxyConfig) (bool, bool, string, error) { applied++; return true, false, "", nil })
	p.testTransport = func(c NetworkProxyConfig) http.RoundTripper {
		return proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
			if r.UserAgent() != httpclient.DefaultUserAgent {
				t.Errorf("proxy test User-Agent=%q", r.UserAgent())
			}
			if r.URL.String() != networkProxyTestURL || c.Server != "test.invalid" {
				t.Fatal(r.URL, c)
			}
			return &http.Response{StatusCode: 204, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
		})
	}
	result, err := p.test(context.Background(), NetworkProxyConfig{Protocol: "HTTP", Server: "test.invalid", Port: 8080})
	if err != nil || !result.Reachable || result.Scope != "go-http-test-only" || saved != 0 || applied != 0 || p.config.Protocol != "off" {
		t.Fatal(result, err, saved, applied, p.config)
	}
}

func TestNetworkProxySaveFailureRollsBack(t *testing.T) {
	var applied []NetworkProxyConfig
	p := newNetworkProxy(func(NetworkProxyConfig) error { return errors.New("disk full") }, func(c NetworkProxyConfig) (bool, bool, string, error) {
		applied = append(applied, c)
		return true, false, "", nil
	})
	receipt, err := p.apply(NetworkProxyConfig{Protocol: "HTTP", Server: "host", Port: 8080})
	if err == nil || receipt.Saved || p.config.Protocol != "off" || len(applied) != 2 || applied[1].Protocol != "off" {
		t.Fatal(receipt, err, applied, p.config)
	}
}

func TestNetworkProxyDownloadTransportAndPartialReceipt(t *testing.T) {
	p := newNetworkProxy(func(NetworkProxyConfig) error { return nil }, func(NetworkProxyConfig) (bool, bool, string, error) { return false, false, "webview-unsupported", nil })
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	p.configureDownloadTransport(transport)
	c := NetworkProxyConfig{Protocol: "HTTPS", Server: "::1", Port: 8443}
	receipt, err := p.apply(c)
	if err != nil || !receipt.Saved || receipt.WebviewApplied || !receipt.DownloadsApplied || receipt.ErrorCode != "webview-unsupported" {
		t.Fatal(receipt, err)
	}
	req, _ := http.NewRequest("GET", "https://download.invalid", nil)
	u, err := transport.Proxy(req)
	if err != nil || u.String() != "https://[::1]:8443" {
		t.Fatal(u, err)
	}
	if _, err = p.apply(NetworkProxyConfig{Protocol: "off"}); err != nil {
		t.Fatal(err)
	}
	if u, _ = transport.Proxy(req); u != nil {
		t.Fatal(u)
	}
}

func TestNetworkProxyDownloadTransportBypassesLocalTargets(t *testing.T) {
	p := newNetworkProxy(func(NetworkProxyConfig) error { return nil }, func(NetworkProxyConfig) (bool, bool, string, error) { return false, false, "webview-unsupported", nil })
	transport := &http.Transport{}
	p.configureDownloadTransport(transport)
	if _, err := p.apply(NetworkProxyConfig{Protocol: "HTTP", Server: "proxy.invalid", Port: 8080}); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"http://127.0.0.1:1234/bearer-token",
		"http://127.1.2.3:1234/bearer-token",
		"http://[::1]:1234/bearer-token",
		"http://[::ffff:127.0.0.1]:1234/bearer-token",
		"http://[::1%25lo0]:1234/bearer-token",
		"http://LOCALHOST.:1234/bearer-token",
		"http://audio.localhost.:1234/bearer-token",
	} {
		req, err := http.NewRequest("GET", target, nil)
		if err != nil {
			t.Fatal(target, err)
		}
		u, err := transport.Proxy(req)
		if err != nil || u != nil {
			t.Errorf("target %q was proxied: %v", target, err)
		}
	}
	for _, target := range []string{"https://music.example/bearer-token", "http://192.168.1.2:1234/bearer-token", "http://10.0.0.4:1234/bearer-token"} {
		req, err := http.NewRequest("GET", target, nil)
		if err != nil {
			t.Fatal(target, err)
		}
		u, err := transport.Proxy(req)
		if err != nil || u == nil || u.String() != "http://proxy.invalid:8080" {
			t.Errorf("target %q was not proxied: %v", target, u)
		}
	}
	redirect, _ := http.NewRequest("GET", "http://127.0.0.1:1234/redirected-bearer", nil)
	if u, err := transport.Proxy(redirect); err != nil || u != nil {
		t.Fatalf("redirect target was proxied: %v", err)
	}
}

func TestNetworkProxyWindowsArguments(t *testing.T) {
	args, err := networkProxyWindowsArguments("--disable-gpu --lang=en", NetworkProxyConfig{Protocol: "HTTP", Server: "proxy.invalid", Port: 8080})
	if err != nil || args != "--disable-gpu --lang=en --proxy-server=http://proxy.invalid:8080" {
		t.Fatal(args, err)
	}
	if _, err = networkProxyWindowsArguments("--proxy-server=old", NetworkProxyConfig{Protocol: "off"}); err == nil {
		t.Fatal("conflicting existing argument accepted")
	}
}
