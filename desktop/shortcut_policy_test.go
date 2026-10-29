package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestNormalizeShortcut(t *testing.T) {
	for _, test := range []struct{ input, goos, want string }{
		{"CmdOrCtrl+Shift+Space", "darwin", "Super+Shift+Space"},
		{"CmdOrCtrl+Shift+ArrowLeft", "windows", "Ctrl+Shift+Left"},
		{" shift + CTRL + ctrl + KeyX ", "darwin", "Ctrl+Shift+X"},
		{"Command+CmdOrCtrl+Digit9", "darwin", "Super+9"},
		{"Alt+ArrowUp", "darwin", "Alt+Up"},
		{"Option+ArrowDown", "darwin", "Alt+Down"},
		{"CommandOrControl+Right", "darwin", "Super+Right"},
		{"F20", "darwin", "F20"},
		{"F24", "windows", "F24"},
		{"KeyP", "darwin", "P"},
		{"Escape", "darwin", "Escape"},
	} {
		t.Run(test.input+test.goos, func(t *testing.T) {
			got, err := normalizeShortcut(test.input, test.goos)
			if err != nil || got != test.want {
				t.Fatalf("got %q, %v; want %q", got, err, test.want)
			}
		})
	}
	for _, input := range []string{"", "  ", "Ctrl+", "Ctrl++A", "Bogus+A", "Ctrl", "KeyAA", "Digit10", "F0", "F01", "F25", "F21", "Numpad0", "MediaPlayPause", "AltGr+A", "Ctrl+é", "Ctrl+Plus"} {
		t.Run("invalid/"+input, func(t *testing.T) {
			if _, err := normalizeShortcut(input, "darwin"); err == nil {
				t.Fatal("expected explicit invalid/unsupported result")
			}
		})
	}
}

type shortcutFake struct {
	callbacks    map[string]func()
	fail         map[string]error
	unregistered []string
	onUnregister func()
}

func (b *shortcutFake) Register(accelerator string, callback func()) error {
	if err := b.fail[accelerator]; err != nil {
		return err
	}
	if b.callbacks[accelerator] != nil {
		return errors.New("already registered by another service")
	}
	b.callbacks[accelerator] = callback
	return nil
}

func (b *shortcutFake) Unregister(accelerator string) {
	delete(b.callbacks, accelerator)
	b.unregistered = append(b.unregistered, accelerator)
	if b.onUnregister != nil {
		b.onUnregister()
	}
}

func newShortcutTestState() (*shortcutState, *shortcutFake, *[]ShortcutEvent) {
	backend := &shortcutFake{callbacks: map[string]func(){}, fail: map[string]error{}}
	events := []ShortcutEvent{}
	state := &shortcutState{
		backend: backend, goos: "darwin",
		valid: func(context.Context) bool { return true },
		emit:  func(event ShortcutEvent) { events = append(events, event) },
	}
	return state, backend, &events
}

func TestShortcutReplaceFeedbackAndOwnership(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx := context.Background()
	backend.fail["Super+N"] = errors.New("system denied registration")
	unrelated := func() {}
	backend.callbacks["Alt+Z"] = unrelated
	status, err := s.replace(ctx, 0, true, []ShortcutBinding{
		{ShortcutPlayOrPause, "CmdOrCtrl+KeyP"},
		{ShortcutPlayNext, "Cmd+P"},
		{ShortcutPlayOrPause, "Ctrl+Q"},
		{ShortcutVolumeUp, ""},
		{ShortcutVolumeDown, "Ctrl+Bogus"},
		{ShortcutPlayPrev, "Cmd+N"},
		{"unknownDesktopLyric", "Ctrl+D"},
		{"openPlayer", "Ctrl+O"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, result := range status.Results {
		got = append(got, result.Status)
		if result.Status != "registered" && result.Status != "empty" && result.Error == "" {
			t.Fatalf("missing error: %+v", result)
		}
	}
	want := []string{"registered", "duplicate-accelerator", "duplicate-action", "empty", "invalid", "registration-failed", "unsupported", "unsupported"}
	if !reflect.DeepEqual(got, want) || status.Results[5].Error != "system denied registration" {
		t.Fatalf("unexpected feedback: %+v", status)
	}
	if !s.check("Command+KeyP").RegisteredByOwner || s.check("Alt+Z").RegisteredByOwner || s.check("Bogus").Error == "" {
		t.Fatal("check must normalize and report service ownership only")
	}
	old := backend.callbacks["Super+P"]
	old()
	if len(*events) != 1 || (*events)[0].Generation != status.Generation {
		t.Fatalf("event mismatch: %+v", *events)
	}
	backend.onUnregister = old
	next, err := s.replace(ctx, status.Generation, true, []ShortcutBinding{{ShortcutPlayNext, "Alt+X"}})
	if err != nil || len(*events) != 1 {
		t.Fatalf("replacement or reentrant callback failed: %+v, %v", next, err)
	}
	old()
	if len(*events) != 1 || s.check("Cmd+P").RegisteredByOwner || !s.check("Alt+X").RegisteredByOwner {
		t.Fatal("old generation remained active")
	}
	if _, err := s.setSuspended(ctx, status.Generation, true); err == nil || !s.check("Alt+X").RegisteredByOwner {
		t.Fatal("late operation damaged replacement owner")
	}
	s.revoke()
	s.revoke()
	if backend.callbacks["Alt+Z"] == nil || len(backend.callbacks) != 1 || len(backend.unregistered) != 2 {
		t.Fatalf("cleanup must be idempotent and preserve unrelated registrations: %+v", backend)
	}
}

func TestShortcutSuspendResumeDisabledAndRetry(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx := context.Background()
	bindings := []ShortcutBinding{{ShortcutPlayOrPause, "Ctrl+P"}}
	status, err := s.replace(ctx, 0, true, bindings)
	if err != nil {
		t.Fatal(err)
	}
	bindings[0].Accelerator = "Ctrl+Q"
	old := backend.callbacks["Ctrl+P"]
	suspended, err := s.setSuspended(ctx, status.Generation, true)
	if err != nil || !suspended.Suspended || len(backend.callbacks) != 0 {
		t.Fatalf("suspend: %+v %v", suspended, err)
	}
	old()
	if len(*events) != 0 {
		t.Fatal("suspended callback fired")
	}
	backend.fail["Ctrl+P"] = errors.New("occupied")
	failed, err := s.setSuspended(ctx, suspended.Generation, false)
	if err != nil || failed.Results[0].Status != "registration-failed" {
		t.Fatalf("resume: %+v %v", failed, err)
	}
	delete(backend.fail, "Ctrl+P")
	retried, err := s.setSuspended(ctx, failed.Generation, false)
	if err != nil || retried.Results[0].Status != "registered" {
		t.Fatalf("retry: %+v %v", retried, err)
	}
	backend.callbacks["Ctrl+P"]()
	if len(*events) != 1 {
		t.Fatal("resumed callback missing")
	}
	disabled, err := s.replace(ctx, retried.Generation, false, []ShortcutBinding{{ShortcutVolumeUp, "Alt+Up"}})
	if err != nil || disabled.Enabled || len(backend.callbacks) != 0 {
		t.Fatalf("disable: %+v %v", disabled, err)
	}
	resumed, err := s.setSuspended(ctx, disabled.Generation, false)
	if err != nil || resumed.Results[0].Status != "disabled" || len(backend.callbacks) != 0 {
		t.Fatal("resume enabled disabled config")
	}
}

func TestShortcutRejectsUnknownAndCanceledOwners(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	unknown := context.WithValue(ctx, struct{}{}, "unknown page")
	eligible := ctx
	s.valid = func(caller context.Context) bool { return caller == eligible }
	bindings := []ShortcutBinding{{ShortcutPlayOrPause, "Ctrl+P"}}
	if _, err := s.replace(unknown, 0, true, bindings); err == nil || len(backend.callbacks) != 0 {
		t.Fatal("unknown page claimed shortcuts")
	}
	status, err := s.replace(ctx, 0, true, bindings)
	if err != nil {
		t.Fatal(err)
	}
	old := backend.callbacks["Ctrl+P"]
	if _, err := s.replace(ctx, 0, true, bindings); err == nil {
		t.Fatal("late initial claim replaced active session")
	}
	cancel()
	old()
	if len(*events) != 0 {
		t.Fatal("canceled owner received event before asynchronous cleanup")
	}
	if _, err := s.replace(ctx, status.Generation, true, bindings); err == nil {
		t.Fatal("canceled owner replaced config")
	}
	s.revoke()
	newCtx := context.Background()
	eligible = newCtx
	newStatus, err := s.replace(newCtx, 0, true, bindings)
	if err != nil {
		t.Fatal(err)
	}
	old()
	if _, err := s.setSuspended(ctx, status.Generation, true); err == nil || !s.check("Ctrl+P").RegisteredByOwner {
		t.Fatal("old owner damaged new owner")
	}
	eligible = unknown
	backend.callbacks["Ctrl+P"]()
	if len(*events) != 0 {
		t.Fatal("revoked lifecycle owner received callback")
	}
	if _, err := s.setSuspended(newCtx, newStatus.Generation, true); err == nil {
		t.Fatal("invalid lifecycle owner accepted")
	}
	s.revoke()
}

func TestShortcutDuplicatePolicyReservesFirstOccurrence(t *testing.T) {
	s, backend, _ := newShortcutTestState()
	backend.fail["Ctrl+P"] = errors.New("occupied")
	status, err := s.replace(context.Background(), 0, true, []ShortcutBinding{
		{ShortcutPlayOrPause, ""}, {ShortcutPlayOrPause, "Ctrl+Q"},
		{ShortcutPlayNext, "Ctrl+P"}, {ShortcutPlayPrev, "Control+KeyP"},
	})
	if err != nil || status.Results[1].Status != "duplicate-action" || status.Results[3].Status != "duplicate-accelerator" || len(backend.callbacks) != 0 {
		t.Fatalf("first occurrence must win even if empty/registration failed: %+v %v", status, err)
	}
}
