package main

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestAuthEphemeralCallbacksCoexistWithPlaybackControl(t *testing.T) {
	_, _, control := controlFixture(t)
	first := newAuthFixture(t)
	second := newAuthFixture(t)
	one := first.prepare(t, 0)
	two := second.prepare(t, 0)
	firstURL, err := url.Parse(one.CallbackURL)
	if err != nil {
		t.Fatal(err)
	}
	secondURL, err := url.Parse(two.CallbackURL)
	if err != nil {
		t.Fatal(err)
	}
	if firstURL.Port() == "" || firstURL.Port() == "0" || firstURL.Host == secondURL.Host || "http://"+firstURL.Host == control.URL || "http://"+secondURL.Host == control.URL {
		t.Fatal("callbacks did not reserve independent loopback ports")
	}
	first.arm(t, one, "first-state", time.Now().Add(time.Minute))
	second.arm(t, two, "second-state", time.Now().Add(time.Minute))
	first.request(t, http.MethodGet, one.CallbackURL+"?state=first-state", http.StatusOK)
	second.request(t, http.MethodGet, two.CallbackURL+"?state=second-state", http.StatusOK)
	for _, pair := range []struct {
		fixture *authFixture
		session AuthCallbackPrepared
	}{{first, one}, {second, two}} {
		select {
		case event := <-pair.fixture.events:
			if event.SessionID != pair.session.SessionID {
				t.Fatal("callback reached a different owner")
			}
		case <-time.After(time.Second):
			t.Fatal("callback event missing")
		}
		assertAuthPortReleased(t, pair.session.CallbackURL)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, control.URL+"/api/control/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := control.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal("OAuth completion stopped playback control", response.StatusCode)
	}
}
