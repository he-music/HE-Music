package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayClientInstanceBoundary(t *testing.T) {
	const instanceID = "fixture-instance"
	var upstream *httptest.Server
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Client-Instance-ID") != "" {
			t.Error("instance ID leaked to external origin")
		}
		http.Redirect(w, r, upstream.URL+"/return", http.StatusFound)
	}))
	defer external.Close()
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/same":
			http.Redirect(w, r, "/echo", http.StatusFound)
		case "/cross":
			http.Redirect(w, r, external.URL, http.StatusFound)
		default:
			w.Header().Set("X-Client-Instance-ID", "resolved-instance")
			fmt.Fprint(w, r.Header.Get("X-Client-Instance-ID"))
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	for _, test := range []struct {
		path string
		want string
	}{
		{"/__api/hemusic/echo", instanceID},
		{"/__api/hemusic/same", instanceID},
		{"/__api/hemusic/cross", ""},
		{"/__api/unblock/echo", ""},
		{"/__proxy/" + gatewayTarget(t, upstream.URL+"/echo"), ""},
	} {
		t.Run(test.path, func(t *testing.T) {
			response, body := gatewayRequest(t, "GET", origin+test.path, "", map[string]string{
				"X-Client-Instance-ID": instanceID,
			})
			if response.StatusCode != http.StatusOK || body != test.want {
				t.Fatalf("returned %d %q; want %q", response.StatusCode, body, test.want)
			}
			if response.Header.Get("X-Client-Instance-ID") != "resolved-instance" || !strings.Contains(response.Header.Get("Access-Control-Expose-Headers"), "X-Client-Instance-ID") {
				t.Fatal("resolved instance header is not exposed")
			}
		})
	}
}
