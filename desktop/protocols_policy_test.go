package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func orpheusFixture(json string) string {
	return "orpheus://" + base64.StdEncoding.EncodeToString([]byte(json))
}
func TestProtocolParse(t *testing.T) {
	for _, raw := range []string{orpheusFixture(`{"type":"song","id":"123","cmd":"play"}`), "kuwo://play?musicrid0=TVVTSUNfMTIz"} {
		intent, ok := parseProtocolURL(raw)
		if !ok || intent.SongID != "123" {
			t.Fatal("valid intent rejected")
		}
	}
	for _, raw := range []string{
		orpheusFixture(`{"type":"song","id":"123","id":"456","cmd":"play"}`),
		orpheusFixture(`{"type":"song","id":"123","cmd":"play","url":"secret"}`),
		orpheusFixture(`{"type":"song","id":"-1","cmd":"play"}`),
		orpheusFixture(`{"type":"song","id":"9007199254740992","cmd":"play"}`),
		orpheusFixture(`{"type":"song","id":"0","cmd":"play"}`),
		orpheusFixture(`{"type":"song","id":"123","cmd":"download"}`),
		orpheusFixture(`{"type":"song","id":"123","cmd":"play"} {}`),
		"kuwo://user@play?musicrid0=TVVTSUNfMTIz", "kuwo://play:80?musicrid0=TVVTSUNfMTIz",
		"kuwo://play?musicrid0=TVVTSUNfMTIz&musicrid0=TVVTSUNfMTIz", "kuwo://play?musicrid0=TVVTSUNfMTIz#x",
		"kuwo://play?musicrid0=TVVTSUNfMTIz&x=1", "kuwo://play/?musicrid0=TVVTSUNfMTIz", "https://play", "orpheus://!", strings.Repeat("x", 2049),
	} {
		if _, ok := parseProtocolURL(raw); ok {
			t.Fatal("unsafe intent accepted")
		}
	}
}

func TestProtocolOrpheusTrailingSlash(t *testing.T) {
	payload := `{"type":"song","id":"123","cmd":"play"}`
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		link := "orpheus://" + encoding.EncodeToString([]byte(payload))
		for _, suffix := range []string{"", "/"} {
			intent, ok := parseProtocolURL(link + suffix)
			if !ok || intent.Platform != "netease" || intent.SongID != "123" {
				t.Fatalf("legacy trailing slash form rejected: suffix %q", suffix)
			}
		}
		for _, suffix := range []string{"//", "%2F", "/?cmd=play", "/#fragment"} {
			if _, ok := parseProtocolURL(link + suffix); ok {
				t.Fatalf("unexpected suffix accepted: %q", suffix)
			}
		}
	}
}

type protocolFake struct {
	fail       bool
	registered map[string]bool
}

func (f *protocolFake) RegisterURLScheme(s string) error {
	if f.fail {
		return context.Canceled
	}
	f.registered[s] = true
	return nil
}
func (f *protocolFake) UnregisterURLScheme(s string) error {
	if f.fail {
		return context.Canceled
	}
	delete(f.registered, s)
	return nil
}
func (f *protocolFake) IsURLSchemeRegistered(s string) bool { return f.registered[s] }
func TestProtocolSessionPolicy(t *testing.T) {
	f := &protocolFake{registered: map[string]bool{}}
	s := protocolState{backend: f}
	ctx := context.Background()
	raw := orpheusFixture(`{"type":"song","id":"123","cmd":"play"}`)
	s.receive(raw)
	s.receive(raw)
	s.revoke() // Initial lifecycle Ready must preserve startup candidates.
	epoch, err := s.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	status, events, err := s.sync(ctx, epoch, []string{"orpheus"})
	if err != nil || len(events) != 1 || status.Results[0].Status != "registered" || events[0].Epoch != status.Epoch || status.Epoch == epoch {
		t.Fatal("startup delivery failed")
	}
	if _, _, err := s.sync(ctx, epoch, nil); err == nil {
		t.Fatal("old epoch accepted")
	}
	if _, _, err := s.sync(context.WithValue(ctx, struct{}{}, true), status.Epoch, nil); err == nil {
		t.Fatal("foreign owner accepted")
	}
	s.receive(raw)
	s.receive(raw)
	if len(s.pending) != 1 {
		t.Fatal("pending duplicates must be merged while allowing a delivered song again")
	}
	status, events, err = s.sync(ctx, status.Epoch, nil)
	if err != nil || len(events) != 0 {
		t.Fatal("disabling protocols must discard pending intents")
	}
	s.receive(orpheusFixture(`{"type":"song","id":"124","cmd":"play"}`))
	if len(s.pending) != 0 {
		t.Fatal("disabled intent accepted")
	}
	s.revoke()
	if _, _, err := s.sync(ctx, status.Epoch, nil); err == nil {
		t.Fatal("revoked owner accepted")
	}
	s.receive(orpheusFixture(`{"type":"song","id":"125","cmd":"play"}`))
	if len(s.pending) != 0 {
		t.Fatal("revoked input cached")
	}
}
func TestProtocolFailureAndBounds(t *testing.T) {
	f := &protocolFake{fail: true, registered: map[string]bool{"orpheus": true}}
	s := protocolState{backend: f, goos: "darwin"}
	ctx := context.Background()
	epoch, _ := s.begin(ctx)
	status, _, err := s.sync(ctx, epoch, []string{"kuwo"})
	if err != nil || status.Results[0].Status != "disabled" || status.Results[1].Status != "registration-failed" {
		t.Fatal("false success")
	}
	if s.enabled["kuwo"] {
		t.Fatal("failed scheme enabled")
	}
	if _, _, err := s.sync(ctx, status.Epoch, []string{"other"}); err == nil {
		t.Fatal("invalid scheme accepted")
	}
	if _, _, err := s.sync(ctx, status.Epoch, []string{"kuwo", "kuwo"}); err == nil {
		t.Fatal("duplicate scheme accepted")
	}
	startup := protocolState{backend: f}
	for i := 1; i <= 50; i++ {
		startup.receive(orpheusFixture(fmt.Sprintf(`{"type":"song","id":"%d","cmd":"play"}`, i)))
	}
	if len(startup.pending) != protocolQueueLimit {
		t.Fatal("queue bound incorrect")
	}
	cancelled, cancel := context.WithCancel(ctx)
	state := protocolState{backend: f}
	e, _ := state.begin(cancelled)
	cancel()
	if _, _, err := state.sync(cancelled, e, nil); err == nil {
		t.Fatal("cancelled owner accepted")
	}
}
