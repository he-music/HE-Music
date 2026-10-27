package main

import (
	"context"
	"testing"
)

func TestShortcutTeardownIdempotenceAndLateSession(t *testing.T) {
	s, backend, events := newShortcutTestState()
	ctx := context.Background()
	binding := []ShortcutBinding{{ShortcutPlayOrPause, "Ctrl+P"}}
	first, err := s.replace(ctx, 0, true, binding)
	if err != nil {
		t.Fatal(err)
	}
	callback := backend.callbacks["Ctrl+P"]
	if err := s.teardown(ctx, first.Generation); err != nil {
		t.Fatal(err)
	}
	generation := s.generation
	if err := s.teardown(ctx, first.Generation); err != nil || s.generation != generation || len(backend.unregistered) != 1 {
		t.Fatalf("repeated teardown must have no side effects: %v", err)
	}
	callback()
	if len(*events) != 0 {
		t.Fatal("late callback after teardown")
	}
	second, err := s.replace(ctx, 0, true, binding)
	if err != nil || second.Generation <= first.Generation {
		t.Fatalf("new session: %+v %v", second, err)
	}
	if err := s.teardown(ctx, first.Generation); err == nil || !s.check("Ctrl+P").RegisteredByOwner || len(backend.unregistered) != 1 {
		t.Fatal("late teardown touched newer session on the same page context")
	}
	unknown := context.WithValue(ctx, struct{}{}, "unrelated page")
	if err := s.teardown(unknown, second.Generation); err == nil || !s.check("Ctrl+P").RegisteredByOwner {
		t.Fatal("unknown page teardown touched current session")
	}
	if err := s.teardown(ctx, 0); err == nil || !s.check("Ctrl+P").RegisteredByOwner {
		t.Fatal("zero generation teardown touched current session")
	}
	if err := s.teardown(ctx, second.Generation); err != nil || len(backend.callbacks) != 0 {
		t.Fatalf("current teardown failed: %v", err)
	}
}
