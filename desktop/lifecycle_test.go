package main

import (
	"bytes"
	"context"
	"image/png"
	"testing"

	"github.com/egoist/mygo"
	desktopassets "github.com/he-music/HE-Music"
)

func TestLifecycleClosePolicy(t *testing.T) {
	for _, test := range []struct {
		name                       string
		ready, tray, tip, quitting bool
		method                     CloseAppMethod
		want                       closeDecision
	}{
		{"before frontend ready", false, true, true, false, CloseAppHide, closeAllow},
		{"tray creation failed", true, false, true, false, CloseAppHide, closeAllow},
		{"hide without tray", true, false, false, false, CloseAppHide, closeAllow},
		{"hide with tray", true, true, false, false, CloseAppHide, closeHide},
		{"show existing close tip", true, true, true, false, CloseAppExit, closePrompt},
		{"exit preference", true, true, false, false, CloseAppExit, closeAllow},
		{"explicit system quit bypasses tip", true, true, true, true, CloseAppHide, closeAllow},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := lifecycleState{tray: test.tray, quitting: test.quitting,
				config: LifecycleConfig{ShowCloseAppTip: test.tip, CloseAppMethod: test.method}}
			if test.ready {
				state.owner = context.Background()
			}
			if got := state.closeDecision(); got != test.want {
				t.Fatalf("closeDecision = %v, want %v", got, test.want)
			}
		})
	}
}

func TestLifecycleCanceledOwnerCannotInterceptClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	state := lifecycleState{owner: ctx, tray: true, config: LifecycleConfig{ShowCloseAppTip: true}}
	cancel()
	if state.owns(ctx) || state.closeDecision() != closeAllow {
		t.Fatal("navigation/destruction must disable close interception immediately")
	}
}

func TestLifecycleOwnership(t *testing.T) {
	mainPage, unknownPage := &mygo.Page{}, &mygo.Page{}
	if !sameLifecyclePage(mainPage, mainPage) || sameLifecyclePage(mainPage, unknownPage) ||
		sameLifecyclePage(nil, nil) || sameLifecyclePage(mainPage, nil) {
		t.Fatal("only the explicitly attached top-level page may own lifecycle calls")
	}
	owner, cancelOwner := context.WithCancel(context.Background())
	defer cancelOwner()
	other, cancelOther := context.WithCancel(context.Background())
	defer cancelOther()
	state := lifecycleState{owner: owner}
	if !state.owns(owner) || state.owns(other) {
		t.Fatal("another page context must not inherit the owner's readiness")
	}
	state.invalidate()
	if state.owns(owner) {
		t.Fatal("teardown must release ownership")
	}
}

func TestLifecycleCloseDeliveryFallback(t *testing.T) {
	state := lifecycleState{owner: context.Background(), tray: true,
		config: LifecycleConfig{ShowCloseAppTip: true}}
	request := state.requestClose()
	if state.acknowledge(request+1) || state.expireRequest(request+1) {
		t.Fatal("stale acknowledgements/timers must not affect the active request")
	}
	if !state.expireRequest(request) || state.closeDecision() != closeAllow {
		t.Fatal("a missing subscriber must allow the pending native close to proceed")
	}
	if state.acknowledge(request) {
		t.Fatal("expired request accepted")
	}
}

func TestLifecycleAcknowledgedPromptWaitsForUser(t *testing.T) {
	state := lifecycleState{owner: context.Background(), tray: true}
	request := state.requestClose()
	if !state.acknowledge(request) || state.expireRequest(request) {
		t.Fatal("an acknowledged confirmation must wait for the user without a timeout")
	}
	state.clearRequest()
	if state.matchesRequest(request) {
		t.Fatal("resolved request still active")
	}
	next := state.requestClose()
	if next == request || state.acknowledge(request) {
		t.Fatal("request IDs must not be reused")
	}
	state.beginQuit()
	if state.matchesRequest(next) || state.closeDecision() != closeAllow {
		t.Fatal("quit must bypass the open confirmation")
	}
}

func TestLifecycleCleanupIsIdempotent(t *testing.T) {
	state := lifecycleState{owner: context.Background(), tray: true}
	state.requestClose()
	if !state.cleanup() || state.cleanup() || state.ready() || state.tray || state.pending != 0 || !state.quitting {
		t.Fatal("cleanup must release readiness, pending requests, and tray exactly once")
	}
	// With no native handles, the service-level cleanup is also safe twice.
	service := &DesktopLifecycle{}
	service.cleanup()
	service.cleanup()
	if service.main != nil || service.tray != nil || !service.state.cleaned {
		t.Fatal("service cleanup left owned resources behind")
	}
}

func TestLifecycleConfigValidation(t *testing.T) {
	for _, method := range []CloseAppMethod{CloseAppHide, CloseAppExit} {
		if err := validateLifecycleConfig(LifecycleConfig{CloseAppMethod: method}); err != nil {
			t.Fatal(err)
		}
	}
	if validateLifecycleConfig(LifecycleConfig{CloseAppMethod: "unknown"}) == nil {
		t.Fatal("invalid close preference accepted")
	}
}

func TestLifecycleEmbeddedTrayIcons(t *testing.T) {
	for name, data := range map[string][]byte{"template": desktopassets.TrayTemplate, "color": desktopassets.TrayColor} {
		t.Run(name, func(t *testing.T) {
			image, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if image.Bounds().Empty() {
				t.Fatal("empty embedded tray icon")
			}
		})
	}
}
