package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// Only API uploads are buffered for redirect replay; media is always streamed.
const gatewayAPIBodyLimit = 32 << 20

var errGatewayBodyLimit = errors.New("API body exceeds 32 MiB")

func readGatewayAPIBody(body io.Reader, length, limit int64) ([]byte, error) {
	if length > limit {
		return nil, errGatewayBodyLimit
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if int64(len(data)) > limit {
		return nil, errGatewayBodyLimit
	}
	return data, err
}

// A reconfigured client can still be serving an old request/redirect. Close its
// idle pool again after that request completes, not only at configuration time.
func (g *NetworkGateway) releaseAPIClient(client *http.Client) {
	g.mu.RLock()
	current := false
	for _, api := range g.apis {
		if api.client == client {
			current = true
			break
		}
	}
	g.mu.RUnlock()
	if !current {
		client.CloseIdleConnections()
	}
}

func (g *NetworkGateway) forward(w http.ResponseWriter, r *http.Request, client *http.Client, target *url.URL, api bool, prefix string) {
	if api {
		defer g.releaseAPIClient(client)
	}
	var body []byte
	if api && r.Body != nil {
		var err error
		body, err = readGatewayAPIBody(r.Body, r.ContentLength, gatewayAPIBodyLimit)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errGatewayBodyLimit) {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(w, "invalid or oversized API body", status)
			return
		}
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	copyDesktopGatewayHeaders(req.Header, r.Header, false)
	req.Header.Del("Cookie")
	req.Header.Del("Referer")
	if !api {
		req.Header.Del("Authorization")
		req.Header.Set("Accept-Encoding", "identity")
	}
	originalOrigin := gatewayURLOrigin(target)
	for redirects := 0; ; redirects++ {
		response, err := client.Do(req)
		if err != nil {
			if r.Context().Err() == nil {
				http.Error(w, "upstream request failed", http.StatusBadGateway)
			}
			return
		}
		if isGatewayRedirect(response.StatusCode) && response.Header.Get("Location") != "" {
			nextReq, nextBody, err := gatewayRedirectRequest(req, response, body, redirects)
			if err != nil {
				response.Body.Close()
				http.Error(w, "invalid upstream redirect", http.StatusBadGateway)
				return
			}
			body = nextBody
			response.Body.Close()
			// Once outside the configured origin, stay on the cookieless media client.
			// Authorization is never restored, even if the chain later returns.
			if gatewayURLOrigin(nextReq.URL) != originalOrigin {
				g.mu.RLock()
				client = g.media
				g.mu.RUnlock()
			}
			req = nextReq
			continue
		}
		defer response.Body.Close()
		g.writeGatewayResponse(w, r, response, req.URL, prefix)
		return
	}
}

func gatewayRedirectRequest(req *http.Request, response *http.Response, body []byte, redirects int) (*http.Request, []byte, error) {
	next, err := req.URL.Parse(response.Header.Get("Location"))
	if err == nil {
		next, err = parseDesktopGatewayURL(next.String())
	}
	if err != nil || redirects >= 10 {
		return nil, nil, errors.New("invalid upstream redirect")
	}
	method := req.Method
	// Match net/http semantics: 301/302/303 convert non-GET/HEAD to GET;
	// 307/308 preserve method and replay the bounded API body.
	if (response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303) && method != "GET" && method != "HEAD" {
		method, body = "GET", nil
	}
	nextReq, err := http.NewRequestWithContext(req.Context(), method, next.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	nextReq.Header = req.Header.Clone()
	// Cookie jars recompute cookies for each hop, including deletions and Path.
	nextReq.Header.Del("Cookie")
	if method != req.Method {
		nextReq.Header.Del("Content-Type")
		nextReq.Header.Del("Content-Length")
	}
	if gatewayURLOrigin(next) != gatewayURLOrigin(req.URL) {
		nextReq.Header.Del("Authorization")
		nextReq.Header.Set("Accept-Encoding", "identity")
	}
	return nextReq, body, nil
}

func (g *NetworkGateway) writeGatewayResponse(w http.ResponseWriter, r *http.Request, response *http.Response, target *url.URL, prefix string) {
	// Non-redirect Location (e.g. 201 Created) must also stay behind the gateway.
	if location := response.Header.Get("Location"); location != "" {
		resolved, err := target.Parse(location)
		if err == nil {
			resolved, err = parseDesktopGatewayURL(resolved.String())
		}
		if err != nil {
			http.Error(w, "invalid upstream location", http.StatusBadGateway)
			return
		}
		w.Header().Set("Location", prefix+"/__proxy/"+resolved.String())
	}
	if isGatewayManifest(response) {
		g.writeManifest(w, r, response, prefix)
		return
	}
	copyDesktopGatewayHeaders(w.Header(), response.Header, true)
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		streamGateway(w, response.Body)
	}
}

func isGatewayRedirect(status int) bool {
	return status == 301 || status == 302 || status == 303 || status == 307 || status == 308
}

var desktopGatewayHopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true,
	"Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Host": true, "Origin": true,
}

// CORP describes the upstream origin, which is no longer the resource origin.
// Retain CSP: document/SVG restrictions still apply to the resource's contents.
var desktopGatewayResponseHeaders = map[string]bool{"Set-Cookie": true, "Location": true, "Cross-Origin-Resource-Policy": true}

func copyDesktopGatewayHeaders(dst, src http.Header, response bool) {
	blocked := map[string]bool{}
	for _, value := range src.Values("Connection") {
		for name := range strings.SplitSeq(value, ",") {
			blocked[http.CanonicalHeaderKey(strings.TrimSpace(name))] = true
		}
	}
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if desktopGatewayHopHeaders[canonical] || blocked[canonical] || strings.HasPrefix(strings.ToLower(key), "access-control-") || response && desktopGatewayResponseHeaders[canonical] {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

var gatewayStreamBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, 32<<10)
	return &buffer
}}

type gatewayFlushWriter struct{ http.ResponseWriter }

func (w gatewayFlushWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}

func streamGateway(w http.ResponseWriter, body io.Reader) {
	buffer := gatewayStreamBuffers.Get().(*[]byte)
	defer gatewayStreamBuffers.Put(buffer)
	// Send headers before the first live chunk; flush each received block so small
	// segments do not wait for HTTP buffering. Abort truncated chunked responses.
	_ = http.NewResponseController(w).Flush()
	if _, err := io.CopyBuffer(gatewayFlushWriter{w}, body, *buffer); err != nil {
		panic(http.ErrAbortHandler)
	}
}
