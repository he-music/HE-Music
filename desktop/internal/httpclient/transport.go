// Package httpclient provides defaults for outgoing Go HTTP requests.
package httpclient

import (
	"net/http"
	"strings"
)

const DefaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

// Transport fills empty User-Agent headers without changing the caller's request.
// Base retains proxy, TLS and connection-pool behavior; nil uses http.DefaultTransport.
type Transport struct {
	Base http.RoundTripper
}

func (t *Transport) base() http.RoundTripper {
	if t.Base == nil {
		return http.DefaultTransport
	}
	return t.Base
}

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.TrimSpace(req.UserAgent()) == "" {
		req = req.Clone(req.Context())
		if req.Header == nil {
			req.Header = make(http.Header)
		}
		req.Header.Set("User-Agent", DefaultUserAgent)
	}
	return t.base().RoundTrip(req)
}

func (t *Transport) CloseIdleConnections() {
	if closer, ok := t.base().(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
