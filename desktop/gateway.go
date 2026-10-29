package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const desktopGatewayMaxTarget = 64 << 10

var desktopGatewayListen = net.Listen

// startDesktopGateway starts the loopback-only gateway used by the renderer.
func startDesktopGateway() (string, func(), error) {
	listener, err := desktopGatewayListen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	server := &http.Server{Handler: newDesktopGatewayHandler(newDesktopGatewayClient())}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			// The server lifetime is owned by stop; an asynchronous serve error has
			// no useful caller here and must not take down the desktop process.
		}
	}()
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
	return "http://" + listener.Addr().String(), stop, nil
}

func desktopGatewayPreloadScript(origin string) string {
	return "if (!Object.prototype.hasOwnProperty.call(window, '__HE_MUSIC_GATEWAY_ORIGIN__')) Object.defineProperty(window, '__HE_MUSIC_GATEWAY_ORIGIN__', { value: " + strconv.Quote(origin) + ", configurable: false });"
}

func newDesktopGatewayClient() *http.Client {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		transport = (&http.Transport{}).Clone()
	} else {
		transport = transport.Clone()
	}
	transport.Proxy = func(req *http.Request) (*url.URL, error) {
		desktopNetworkProxy.mu.RLock()
		config := desktopNetworkProxy.config
		desktopNetworkProxy.mu.RUnlock()
		return networkProxyURL(config)
	}
	transport.ResponseHeaderTimeout = 15 * time.Second
	transport.MaxIdleConns = 100
	transport.MaxIdleConnsPerHost = 10
	transport.MaxConnsPerHost = 0
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func newDesktopGatewayHandler(client *http.Client) http.Handler {
	if client == nil {
		client = newDesktopGatewayClient()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleDesktopGateway(w, r, client)
	})
}

func handleDesktopGateway(w http.ResponseWriter, r *http.Request, client *http.Client) {
	if r.URL.Path == "/__health" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, "ok\n")
		}
		return
	}
	if r.URL.Path != "/__proxy" {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		handleDesktopGatewayOptions(w, r)
		return
	}
	if r.Method == http.MethodConnect || r.Method == "TRACE" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	target, err := decodeDesktopGatewayTarget(r.URL.Query().Get("target"))
	if err != nil {
		http.Error(w, "invalid target", http.StatusBadRequest)
		return
	}
	upstreamRequest, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, "invalid target", http.StatusBadRequest)
		return
	}
	copyDesktopGatewayHeaders(upstreamRequest.Header, r.Header, false)
	upstreamRequest.Host = target.Host
	response, err := client.Do(upstreamRequest)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	copyDesktopGatewayHeaders(w.Header(), response.Header, true)
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Add("Vary", "Origin")
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func handleDesktopGatewayOptions(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH")
	if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
		w.Header().Set("Access-Control-Allow-Headers", requested)
	}
	w.Header().Set("Access-Control-Max-Age", "600")
	w.WriteHeader(http.StatusNoContent)
}

func decodeDesktopGatewayTarget(encoded string) (*url.URL, error) {
	if encoded == "" {
		return nil, errors.New("missing target")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) == 0 || len(decoded) > desktopGatewayMaxTarget {
		return nil, errors.New("invalid target encoding")
	}
	target, err := url.Parse(string(decoded))
	if err != nil || target == nil {
		return nil, errors.New("invalid target URL")
	}
	if scheme := strings.ToLower(target.Scheme); scheme != "http" && scheme != "https" {
		return nil, errors.New("target scheme is not allowed")
	}
	if target.Host == "" || target.Hostname() == "" || target.User != nil || target.Fragment != "" || target.Opaque != "" {
		return nil, errors.New("target authority is not allowed")
	}
	return target, nil
}

var desktopGatewayHopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true,
	"Proxy-Authorization": true, "TE": true, "Trailer": true,
	"Transfer-Encoding": true, "Upgrade": true, "Host": true,
	"Origin": true,
}

func copyDesktopGatewayHeaders(dst, src http.Header, response bool) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if desktopGatewayHopHeaders[canonical] {
			continue
		}
		if response && canonical == "Set-Cookie" {
			// Cookies from an arbitrary target must not become gateway cookies.
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}
