package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/netproxy"
)

const macUpdatesBaseURL = "https://github.com/he-music/HE-Music/releases/latest/download/"

var errUpdatesStalled = errors.New("update download stalled: the connection sent nothing")

// macUpdatesSource restores architecture-first manifest lookup. The official
// updater still parses manifests, checks signatures and installs the archives.
type macUpdatesSource struct {
	arch         string
	client       *http.Client
	retryDelays  []time.Duration
	stallTimeout time.Duration
}

var _ mygo.UpdateSource = (*macUpdatesSource)(nil)

func newMacUpdatesSource(arch string) *macUpdatesSource {
	transport := netproxy.Transport().Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &macUpdatesSource{
		arch: arch, client: &http.Client{Transport: transport},
		retryDelays: []time.Duration{time.Second, 3 * time.Second}, stallTimeout: time.Minute,
	}
}

func (s *macUpdatesSource) Manifest(ctx context.Context, prereleases bool) (io.ReadCloser, error) {
	if prereleases {
		return nil, errors.New("prerelease updates are not configured")
	}
	body, err := s.Open(ctx, macUpdatesBaseURL+"update-darwin-"+s.arch+".json")
	if failure, ok := errors.AsType[*updatesHTTPError](err); ok && failure.status == http.StatusNotFound {
		return s.Open(ctx, macUpdatesBaseURL+"update-darwin-universal.json")
	}
	return body, err
}

// Open retains system proxy routing, transient-error retries and bounded waits
// for headers and stalled reads, including downloads started by the SDK.
func (s *macUpdatesSource) Open(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return nil, errors.New("updates require HTTPS")
	}
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		requestCtx, cancel := context.WithCancelCause(ctx)
		req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel(nil)
			return nil, err
		}
		req.Header.Set("User-Agent", "mygo-updater")
		response, err := s.client.Do(req)
		var retryAfter time.Duration
		if err == nil {
			if response.StatusCode == http.StatusOK {
				return &updatesResponseBody{ReadCloser: response.Body, ctx: requestCtx, cancel: cancel, stallTimeout: s.stallTimeout}, nil
			}
			response.Body.Close()
			err = &updatesHTTPError{status: response.StatusCode, url: rawURL}
			if !retryUpdatesStatus(response.StatusCode) {
				cancel(nil)
				return nil, err
			}
			if seconds, parseErr := strconv.Atoi(strings.TrimSpace(response.Header.Get("Retry-After"))); parseErr == nil && seconds > 0 {
				retryAfter = time.Duration(min(seconds, 30)) * time.Second
			}
		}
		cancel(nil)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if attempt >= len(s.retryDelays) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(max(retryAfter, s.retryDelays[attempt])):
		}
	}
}

func retryUpdatesStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

type updatesHTTPError struct {
	status int
	url    string
}

func (e *updatesHTTPError) Error() string {
	return fmt.Sprintf("GET %s: %d %s", e.url, e.status, http.StatusText(e.status))
}

type updatesResponseBody struct {
	io.ReadCloser
	ctx          context.Context
	cancel       context.CancelCauseFunc
	stallTimeout time.Duration
}

// Each blocked read has a deadline; a download that keeps sending bytes may
// take as long as needed. Closing the body or cancelling its owner stops it.
func (b *updatesResponseBody) Read(p []byte) (int, error) {
	timer := time.AfterFunc(b.stallTimeout, func() { b.cancel(errUpdatesStalled) })
	n, err := b.ReadCloser.Read(p)
	timer.Stop()
	if err != nil && errors.Is(context.Cause(b.ctx), errUpdatesStalled) {
		return n, errUpdatesStalled
	}
	return n, err
}

func (b *updatesResponseBody) Close() error {
	b.cancel(nil)
	return b.ReadCloser.Close()
}
