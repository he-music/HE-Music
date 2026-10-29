package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestShortcutDesktopLyricEventAndLifecycle(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	binding := []ShortcutBinding{{ShortcutAction("toggleDesktopLyric"), "CmdOrCtrl+Shift+L"}}
	status, err := s.replace(ctx, 0, true, binding)
	if err != nil || len(status.Results) != 1 || status.Results[0].Status != "registered" {
		t.Fatalf("desktop lyric registration: %+v %v", status, err)
	}
	first := backend.callbacks["Super+Shift+L"]
	first()
	want := []ShortcutEvent{{Generation: status.Generation, Action: ShortcutAction("toggleDesktopLyric")}}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("existing shortcut event payload: got %+v, want %+v", *events, want)
	}

	backend.onUnregister = first
	replaced, err := s.replace(ctx, status.Generation, true, binding)
	if err != nil || replaced.Results[0].Status != "registered" {
		t.Fatalf("replace: %+v %v", replaced, err)
	}
	first()
	if !reflect.DeepEqual(*events, want) {
		t.Fatal("replaced or reentrant callback emitted an event")
	}
	second := backend.callbacks["Super+Shift+L"]
	backend.onUnregister = second
	suspended, err := s.setSuspended(ctx, replaced.Generation, true)
	if err != nil || !suspended.Suspended || suspended.Results[0].Status != "disabled" || len(backend.callbacks) != 0 {
		t.Fatalf("suspend: %+v %v", suspended, err)
	}
	second()
	if !reflect.DeepEqual(*events, want) {
		t.Fatal("suspended callback emitted an event")
	}
	resumed, err := s.setSuspended(ctx, suspended.Generation, false)
	if err != nil || resumed.Results[0].Status != "registered" {
		t.Fatalf("resume: %+v %v", resumed, err)
	}
	third := backend.callbacks["Super+Shift+L"]
	third()
	want = append(want, ShortcutEvent{Generation: resumed.Generation, Action: ShortcutAction("toggleDesktopLyric")})
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("resumed event: %+v", *events)
	}
	backend.onUnregister = third
	if err := s.teardown(ctx, resumed.Generation); err != nil {
		t.Fatal(err)
	}
	if err := s.teardown(ctx, resumed.Generation); err != nil {
		t.Fatalf("repeated teardown: %v", err)
	}
	third()
	if len(backend.callbacks) != 0 || !reflect.DeepEqual(*events, want) {
		t.Fatal("teardown left an active callback")
	}

	newCtx, cancelNew := context.WithCancel(context.Background())
	defer cancelNew()
	claimed, err := s.replace(newCtx, 0, true, binding)
	if err != nil || claimed.Results[0].Status != "registered" {
		t.Fatalf("new owner: %+v %v", claimed, err)
	}
	first()
	second()
	third()
	if err := s.teardown(ctx, resumed.Generation); err == nil {
		t.Fatal("late teardown accepted after new owner claimed shortcuts")
	}
	if _, err := s.setSuspended(ctx, resumed.Generation, true); err == nil {
		t.Fatal("late suspend accepted after new owner claimed shortcuts")
	}
	if _, err := s.replace(ctx, resumed.Generation, true, binding); err == nil {
		t.Fatal("late replace accepted after new owner claimed shortcuts")
	}
	if !s.check("Command+Shift+KeyL").RegisteredByOwner || !reflect.DeepEqual(*events, want) {
		t.Fatal("old owner affected new registration or emitted an event")
	}
	current := backend.callbacks["Super+Shift+L"]
	current()
	want = append(want, ShortcutEvent{Generation: claimed.Generation, Action: ShortcutAction("toggleDesktopLyric")})
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("new owner event: %+v", *events)
	}
	cancelNew()
	current()
	if !reflect.DeepEqual(*events, want) {
		t.Fatal("canceled owner received desktop lyric event")
	}
	s.revoke()
}

func TestShortcutDesktopLyricFeedback(t *testing.T) {
	for _, test := range []struct {
		name     string
		enabled  bool
		bindings []ShortcutBinding
		failure  bool
		want     []string
	}{
		{"unknown", true, []ShortcutBinding{{"unknownDesktopLyric", "Ctrl+L"}}, false, []string{"unsupported"}},
		{"duplicate action", true, []ShortcutBinding{{"toggleDesktopLyric", "Ctrl+L"}, {"toggleDesktopLyric", "Ctrl+K"}}, false, []string{"registered", "duplicate-action"}},
		{"duplicate accelerator", true, []ShortcutBinding{{"toggleDesktopLyric", "Ctrl+L"}, {ShortcutPlayNext, "Control+KeyL"}}, false, []string{"registered", "duplicate-accelerator"}},
		{"accelerator already claimed", true, []ShortcutBinding{{ShortcutPlayNext, "Ctrl+L"}, {"toggleDesktopLyric", "Control+KeyL"}}, false, []string{"registered", "duplicate-accelerator"}},
		{"empty first action", true, []ShortcutBinding{{"toggleDesktopLyric", ""}, {"toggleDesktopLyric", "Ctrl+L"}}, false, []string{"empty", "duplicate-action"}},
		{"registration failure reserves accelerator", true, []ShortcutBinding{{"toggleDesktopLyric", "Ctrl+L"}, {ShortcutPlayNext, "Control+KeyL"}}, true, []string{"registration-failed", "duplicate-accelerator"}},
		{"disabled", false, []ShortcutBinding{{"toggleDesktopLyric", "Ctrl+L"}}, false, []string{"disabled"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, backend, events := newShortcutTestState()
			if test.failure {
				backend.fail["Ctrl+L"] = errors.New("system denied registration")
			}
			status, err := s.replace(context.Background(), 0, test.enabled, test.bindings)
			if err != nil {
				t.Fatal(err)
			}
			got := []string{}
			for _, result := range status.Results {
				got = append(got, result.Status)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("feedback: got %v, want %v", got, test.want)
			}
			if test.failure && (status.Results[0].Error != "system denied registration" || s.check("Ctrl+L").RegisteredByOwner || len(backend.callbacks) != 0) {
				t.Fatalf("failed registration became owned: %+v", status)
			}
			if len(*events) != 0 {
				t.Fatal("configuration emitted an action event")
			}
			s.revoke()
		})
	}
}

func TestShortcutDesktopLyricRegistrationRetry(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx := context.Background()
	backend.fail["Ctrl+L"] = errors.New("occupied")
	failed, err := s.replace(ctx, 0, true, []ShortcutBinding{{"toggleDesktopLyric", "Ctrl+L"}})
	if err != nil || failed.Results[0].Status != "registration-failed" || failed.Results[0].Error != "occupied" {
		t.Fatalf("failure: %+v %v", failed, err)
	}
	delete(backend.fail, "Ctrl+L")
	retried, err := s.setSuspended(ctx, failed.Generation, false)
	if err != nil || retried.Results[0].Status != "registered" {
		t.Fatalf("retry: %+v %v", retried, err)
	}
	backend.callbacks["Ctrl+L"]()
	want := []ShortcutEvent{{Generation: retried.Generation, Action: ShortcutAction("toggleDesktopLyric")}}
	if !reflect.DeepEqual(*events, want) {
		t.Fatalf("retry event: got %+v, want %+v", *events, want)
	}
	s.revoke()
}
