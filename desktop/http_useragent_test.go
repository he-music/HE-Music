package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/transform"
	"github.com/he-music/HE-Music/desktop/internal/httpclient"
)

func TestGatewayDefaultUserAgentAcrossRoutes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/final", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(r.UserAgent()))
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	for _, route := range []string{"/__api/hemusic/redirect", "/__api/unblock/redirect", "/__proxy/" + upstream.URL + "/redirect"} {
		for _, agent := range []string{"", "custom-media-client"} {
			response, data := gatewayRequest(t, http.MethodGet, origin+route, "", map[string]string{"User-Agent": agent})
			want := agent
			if want == "" {
				want = httpclient.DefaultUserAgent
			}
			if response.StatusCode != http.StatusOK || data != want {
				t.Fatalf("route=%s status=%d User-Agent=%q want=%q", route, response.StatusCode, data, want)
			}
		}
	}
}

func TestDownloadClientDefaultUserAgent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != httpclient.DefaultUserAgent {
			t.Errorf("download User-Agent=%q", r.UserAgent())
		}
		_, _ = w.Write([]byte("audio"))
	}))
	defer upstream.Close()
	_, ctx, _, coordinator, _, _ := downloadFixture(t)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := coordinator.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}

func TestSampleAudioDefaultUserAgent(t *testing.T) {
	file, encoded := sampleGatewayFixture(t)
	params, err := transform.Parse(encoded)
	if err != nil {
		t.Fatal(err)
	}
	params.UserAgent = ""
	encoded, err = transform.Encode(params)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != httpclient.DefaultUserAgent {
			t.Errorf("sample User-Agent=%q", r.UserAgent())
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(file)))
		if r.Method != http.MethodHead {
			_, _ = w.Write(file)
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	for _, method := range []string{http.MethodHead, http.MethodGet} {
		response, _ := gatewayRequest(t, method, gatewayAudioURL(origin, upstream.URL, encoded, "m4a"), "", nil)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d", method, response.StatusCode)
		}
	}
}
