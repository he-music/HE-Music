package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/he-music/HE-Music/desktop/internal/httpclient"
)

type NetworkProxyConfig struct {
	Protocol string `json:"protocol"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
}

type NetworkProxyReceipt struct {
	Saved            bool   `json:"saved"`
	GatewayApplied   bool   `json:"gatewayApplied"`
	WebviewApplied   bool   `json:"webviewApplied"`
	DownloadsApplied bool   `json:"downloadsApplied"`
	RestartRequired  bool   `json:"restartRequired"`
	ErrorCode        string `json:"errorCode"`
}

type NetworkProxyTestResult struct {
	Reachable bool   `json:"reachable"`
	Scope     string `json:"scope"`
}

const networkProxyTestURL = "https://music.163.com/"

var errNetworkProxyConfig = errors.New("invalid proxy protocol, host or port")

// Hosts are bare ASCII DNS names or IP literals; URLs, credentials, flags,
// zones and bracketed literals are rejected before reaching native APIs.
func networkProxyURL(c NetworkProxyConfig) (*url.URL, error) {
	if c.Protocol == "off" {
		return nil, nil
	}
	if (c.Protocol != "HTTP" && c.Protocol != "HTTPS") || c.Port < 1 || c.Port > 65535 || len(c.Server) == 0 || len(c.Server) > 253 {
		return nil, errNetworkProxyConfig
	}
	if net.ParseIP(c.Server) == nil && !validNetworkProxyDNS(c.Server) {
		return nil, errNetworkProxyConfig
	}
	return &url.URL{Scheme: strings.ToLower(c.Protocol), Host: net.JoinHostPort(c.Server, strconv.Itoa(c.Port))}, nil
}

func validNetworkProxyDNS(server string) bool {
	for label := range strings.SplitSeq(server, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if (ch < 'a' || ch > 'z') && (ch < 'A' || ch > 'Z') && (ch < '0' || ch > '9') && ch != '-' {
				return false
			}
		}
	}
	return true
}

func normalizedNetworkProxy(c NetworkProxyConfig) NetworkProxyConfig {
	if c.Protocol == "off" {
		return NetworkProxyConfig{Protocol: "off"}
	}
	c.Server = strings.ToLower(c.Server)
	return c
}

type (
	networkProxyApply func(NetworkProxyConfig) (gatewayApplied, restartRequired bool, errorCode string, err error)
	NetworkProxy      struct {
		mu            sync.RWMutex
		config        NetworkProxyConfig
		downloads     bool
		save          func(NetworkProxyConfig) error
		applyRoute    networkProxyApply
		testTransport func(NetworkProxyConfig) http.RoundTripper
	}
)

func newNetworkProxy(save func(NetworkProxyConfig) error, apply networkProxyApply) *NetworkProxy {
	return &NetworkProxy{config: NetworkProxyConfig{Protocol: "off"}, save: save, applyRoute: apply, testTransport: func(c NetworkProxyConfig) http.RoundTripper {
		u, _ := networkProxyURL(c)
		return &http.Transport{Proxy: http.ProxyURL(u), TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second, DisableKeepAlives: true}
	}}
}

// apply is serialized on the lifecycle main thread by the bound entry point.
// Only persisted configurations become visible to subsequent Go requests.
func (p *NetworkProxy) apply(c NetworkProxyConfig) (NetworkProxyReceipt, error) {
	receipt := NetworkProxyReceipt{}
	if _, err := networkProxyURL(c); err != nil {
		return receipt, err
	}
	c = normalizedNetworkProxy(c)
	p.mu.RLock()
	old := p.config
	p.mu.RUnlock()
	gateway, restart, code, err := p.applyRoute(c)
	if err != nil {
		return receipt, err
	}
	if err = p.save(c); err != nil {
		_, _, _, rollbackErr := p.applyRoute(old)
		return receipt, errors.Join(err, rollbackErr)
	}
	p.mu.Lock()
	p.config = c
	downloads := p.downloads
	p.mu.Unlock()
	return NetworkProxyReceipt{Saved: true, GatewayApplied: gateway, DownloadsApplied: downloads, RestartRequired: restart, ErrorCode: code}, nil
}

// networkProxyDirect reports destinations that must stay on the local route.
// It only uses the URL host and never resolves DNS; private non-loopback IPs
// therefore remain eligible for the configured proxy.
func networkProxyDirect(req *http.Request) bool {
	if req == nil || req.URL == nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(req.URL.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if zone := strings.LastIndexByte(host, '%'); zone >= 0 {
		host = host[:zone]
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return ipv4[0] == 127
	}
	return ip.Equal(net.ParseIP("::1"))
}

// Install only on the dedicated authorized-download transport, before its first
// request. The closure reads current routing without mutating an active Transport.
func (p *NetworkProxy) configureDownloadTransport(t *http.Transport) {
	t.Proxy = func(req *http.Request) (*url.URL, error) {
		if networkProxyDirect(req) {
			return nil, nil
		}
		p.mu.RLock()
		c := p.config
		p.mu.RUnlock()
		return networkProxyURL(c)
	}
	p.mu.Lock()
	p.downloads = true
	p.mu.Unlock()
}

func (p *NetworkProxy) test(ctx context.Context, c NetworkProxyConfig) (NetworkProxyTestResult, error) {
	result := NetworkProxyTestResult{Scope: "go-http-test-only"}
	if _, err := networkProxyURL(c); err != nil {
		return result, err
	}
	if c.Protocol == "off" {
		return result, errors.New("proxy test requires HTTP or HTTPS")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	transport := p.testTransport(c)
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		defer closer.CloseIdleConnections()
	}
	client := &http.Client{Transport: &httpclient.Transport{Base: transport}, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, networkProxyTestURL, nil)
	if err != nil {
		return result, err
	}
	response, err := client.Do(req)
	if err != nil {
		return result, errors.New("proxy test request failed")
	}
	defer response.Body.Close()
	result.Reachable = response.StatusCode >= 200 && response.StatusCode < 400
	return result, nil
}

// Existing WebView2 proxy switches are an explicit conflict, never silently
// overwritten. The validated URL cannot insert whitespace or extra switches.
func networkProxyWindowsArguments(existing string, c NetworkProxyConfig) (string, error) {
	u, err := networkProxyURL(c)
	if err != nil {
		return "", err
	}
	for _, flag := range []string{"--proxy-server", "--proxy-pac-url", "--no-proxy-server", "--proxy-auto-detect", "--proxy-bypass-list"} {
		if strings.Contains(strings.ToLower(existing), flag) {
			return "", fmt.Errorf("existing WebView2 proxy argument conflicts")
		}
	}
	if u == nil {
		return existing, nil
	}
	separator := ""
	if existing != "" {
		separator = " "
	}
	return existing + separator + "--proxy-server=" + u.String(), nil
}
