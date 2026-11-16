package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestMacUpdatesSourceManifestFallback(t *testing.T) {
	for _, tc := range []struct {
		name      string
		arch      string
		primary   int
		fallback  int
		wantPaths []string
		wantError bool
	}{
		{"arm64 first", "arm64", 200, 200, []string{"/update-darwin-arm64.json"}, false},
		{"amd64 first", "amd64", 200, 200, []string{"/update-darwin-amd64.json"}, false},
		{"arm64 missing", "arm64", 404, 200, []string{"/update-darwin-arm64.json", "/update-darwin-universal.json"}, false},
		{"amd64 missing", "amd64", 404, 200, []string{"/update-darwin-amd64.json", "/update-darwin-universal.json"}, false},
		{"both missing", "arm64", 404, 404, []string{"/update-darwin-arm64.json", "/update-darwin-universal.json"}, true},
		{"forbidden", "arm64", 403, 200, []string{"/update-darwin-arm64.json"}, true},
		{"server failure", "arm64", 503, 200, []string{"/update-darwin-arm64.json", "/update-darwin-arm64.json", "/update-darwin-arm64.json"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var paths []string
			var bodies []*updatesTestBody
			source := newMacUpdatesSource(tc.arch)
			source.retryDelays = []time.Duration{0, 0}
			source.client.Transport = proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
				paths = append(paths, strings.TrimPrefix(r.URL.String(), "https://github.com/he-music/HE-Music/releases/latest/download"))
				status := tc.primary
				if strings.HasSuffix(r.URL.Path, "-universal.json") {
					status = tc.fallback
				}
				body := &updatesTestBody{Reader: strings.NewReader("signed manifest bytes")}
				bodies = append(bodies, body)
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: body}, nil
			})
			body, err := source.Manifest(t.Context(), false)
			if (err != nil) != tc.wantError {
				t.Fatalf("Manifest error = %v", err)
			}
			if body != nil {
				data, readErr := io.ReadAll(body)
				body.Close()
				if readErr != nil || string(data) != "signed manifest bytes" {
					t.Fatalf("manifest content changed: %q, %v", data, readErr)
				}
			}
			if !slices.Equal(paths, tc.wantPaths) {
				t.Fatalf("requested %v, want %v", paths, tc.wantPaths)
			}
			for _, body := range bodies {
				if !body.closed {
					t.Fatal("response body left open")
				}
			}
		})
	}
}

type updatesTestBody struct {
	*strings.Reader
	closed bool
}

func (b *updatesTestBody) Close() error { b.closed = true; return nil }

func TestMacUpdatesSourceNetworkErrorDoesNotFallback(t *testing.T) {
	source := newMacUpdatesSource("arm64")
	source.retryDelays = nil
	failure := errors.New("network unavailable")
	calls := 0
	source.client.Transport = proxyRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, failure
	})
	if _, err := source.Manifest(t.Context(), false); !errors.Is(err, failure) || calls != 1 {
		t.Fatalf("unexpected fallback after network failure: %v, calls=%d", err, calls)
	}
}

func TestMacUpdatesSourceRetriesAndDownloadsUnchangedArchive(t *testing.T) {
	source := newMacUpdatesSource("arm64")
	source.retryDelays = []time.Duration{0}
	calls := 0
	const archiveURL = "https://github.com/he-music/HE-Music/releases/download/v2.0.4/he-music-2.0.4-darwin-universal.tar.gz"
	source.client.Transport = proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != archiveURL || r.UserAgent() != "mygo-updater" {
			t.Fatalf("download request changed: %s, %s", r.URL, r.UserAgent())
		}
		status := http.StatusOK
		if calls == 1 {
			status = http.StatusServiceUnavailable
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("archive bytes"))}, nil
	})
	body, err := source.Open(t.Context(), archiveURL)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	data, err := io.ReadAll(body)
	if err != nil || string(data) != "archive bytes" || calls != 2 {
		t.Fatalf("archive download = %q, %v, calls=%d", data, err, calls)
	}
}

func TestMacUpdatesSourceCancelsStalledBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	source := newMacUpdatesSource("arm64")
	source.stallTimeout = 50 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	body, err := source.Open(ctx, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	if _, err = io.ReadAll(body); !errors.Is(err, errUpdatesStalled) {
		t.Fatalf("stalled download error = %v", err)
	}
}

func TestMacUpdatesSourceCancellationAndHTTPS(t *testing.T) {
	source := newMacUpdatesSource("arm64")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := source.Manifest(ctx, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	if _, err := source.Open(t.Context(), "http://example.com/update.json"); err == nil {
		t.Fatal("insecure remote update accepted")
	}
}

func TestMacUpdatesSourcePublishedManifest(t *testing.T) {
	if os.Getenv("HE_MUSIC_UPDATE_SOURCE_LIVE") != "1" {
		t.Skip("未启用真实发布源检查")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	body, err := newMacUpdatesSource("arm64").Manifest(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, 1<<20))
	if err != nil || !strings.Contains(string(data), `"version"`) || !strings.Contains(string(data), `darwin-universal.tar.gz`) {
		t.Fatalf("unexpected published manifest: %q, %v", data, err)
	}
	t.Log("对应架构清单缺失时，成功读取真实 Universal 更新清单")
}
