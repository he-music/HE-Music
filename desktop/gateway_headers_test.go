package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayNonRedirectLocationAndCookieDeletionAtRedirect(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/created":
			w.Header().Set("Location", "/art?x=1")
			w.WriteHeader(201)
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "fixture", Path: "/"})
		case "/logout":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "", Path: "/", MaxAge: -1})
			http.Redirect(w, r, "/check", http.StatusFound)
		default:
			_, _ = io.WriteString(w, r.Header.Get("Cookie"))
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	response, _ := gatewayRequest(t, "POST", origin+"/__api/hemusic/created", "", nil)
	if response.StatusCode != 201 || response.Header.Get("Location") != "/test-secret/__proxy/"+gatewayTarget(t, upstream.URL+"/art?x=1") {
		t.Fatalf("created Location %d %v", response.StatusCode, response.Header)
	}
	gatewayRequest(t, "GET", origin+"/__api/hemusic/login", "", nil)
	_, body := gatewayRequest(t, "GET", origin+"/__api/hemusic/logout", "", nil)
	if body != "" {
		t.Fatalf("redirect reused deleted cookie %q", body)
	}
}

func TestGatewayRedirectHopBoundary(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var remaining int
		_, _ = fmt.Sscanf(r.URL.Path, "/%d", &remaining)
		if remaining > 0 {
			http.Redirect(w, r, fmt.Sprintf("/%d", remaining-1), http.StatusFound)
			return
		}
		fmt.Fprint(w, "complete")
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	for _, hops := range []int{10, 11} {
		response, body := gatewayRequest(t, "GET", origin+"/__proxy/"+gatewayTarget(t, fmt.Sprintf("%s/%d", upstream.URL, hops)), "", nil)
		if hops == 10 && (response.StatusCode != 200 || body != "complete") || hops == 11 && response.StatusCode != 502 {
			t.Fatalf("%d hops returned %d %q", hops, response.StatusCode, body)
		}
	}
}

func TestGatewayRejectsInvalidTargetsAndMediaUploads(t *testing.T) {
	for _, raw := range []string{"", "ftp://music.invalid", "https:///missing-host", "https://user:pass@music.invalid", "https://music.invalid/#fragment", "https://music.invalid/%zz"} {
		if _, err := parseDesktopGatewayURL(raw); err == nil {
			t.Errorf("accepted target %q", raw)
		}
	}
	for _, raw := range []string{"missing-protocol", "https://media.invalid/" + strings.Repeat("x", desktopGatewayMaxTarget+1)} {
		if _, err := parseDesktopGatewayURL(raw); err == nil {
			t.Error("accepted malformed or oversized target")
		}
	}
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	response, _ := gatewayRequest(t, "POST", origin+"/__proxy/"+gatewayTarget(t, "http://unused.invalid"), "body", map[string]string{"Authorization": "fixture"})
	if response.StatusCode != 405 {
		t.Fatal("media accepted authenticated upload")
	}
}

func TestGatewayImageResourcePolicyWithoutCORSMode(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		fmt.Fprint(w, "<svg/>")
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, gatewayConfig(upstream.URL))
	for _, route := range []string{"/__api/hemusic/image", "/__proxy/" + gatewayTarget(t, upstream.URL+"/image")} {
		// NImage/img may send no Origin at all. CORP would still block it in no-cors.
		response, body := gatewayRequest(t, "GET", origin+route, "", nil)
		if response.StatusCode != 200 || body != "<svg/>" || response.Header.Get("Cross-Origin-Resource-Policy") != "" || response.Header.Get("Content-Security-Policy") != "default-src 'none'" {
			t.Fatalf("resource policy %d %v %q", response.StatusCode, response.Header, body)
		}
	}
}
