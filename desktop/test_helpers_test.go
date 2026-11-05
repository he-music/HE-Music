package main

import (
	"errors"
	"testing"
	"time"
)

// 模拟页面身份时使用独立的私有键，避免与业务 context 的键冲突。
type testContextKey struct{}

func requireTestNoError(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func requireTestEqual[T comparable](t testing.TB, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func requireTestError(t testing.TB, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
}

func requireTestErrorIs(t testing.TB, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("got error %v, want %v", err, target)
	}
}

func requireTestNotEqual[T comparable](t testing.TB, got, unwanted T) {
	t.Helper()
	if got == unwanted {
		t.Fatalf("unexpected value %v", got)
	}
}

func requireTestSignal(t testing.TB, signal <-chan struct{}, timeout time.Duration, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(timeout):
		t.Fatal(message)
	}
}
