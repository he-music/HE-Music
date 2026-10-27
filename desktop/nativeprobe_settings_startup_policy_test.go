//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func validStartupFixture(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"initialPreparationPassed": true, "finalSurfaceSafe": true,
		"preparationError": "unavailable", "unknownFailures": 0,
		"unsafeSurfaceObserved": false,
		"current": map[string]any{
			"documentId": "00000000-0000-4000-8000-000000000001", "sameDocument": true,
			"revision": 0, "errors": 0, "rejections": 0, "unknownErrors": 0,
			"unsafe": false, "empty": true, "modals": 0, "unknown": 0, "drawers": 0, "settings": 0,
			"active": true, "rafCount": 0, "timerCount": 0, "vueFlushCompleted": true,
			"visibility": "visible", "hidden": false, "hasFocus": true, "apiId": "1", "nodes": []any{},
		},
		"snapshots": []any{}, "events": map[string]any{"run": 0, "end": 0, "cancel": 0, "animationEnd": 0},
	}
}
func TestStartupObservationRequiredFields(t *testing.T) {
	baseline := validStartupFixture(t)
	if _, err := decodeStartupObservation(baseline); err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}
	for key := range baseline {
		t.Run("top-"+key, func(t *testing.T) {
			value := validStartupFixture(t)
			delete(value, key)
			if _, err := decodeStartupObservation(value); err == nil {
				t.Fatal("missing field accepted")
			}
		})
	}
	for key := range baseline["current"].(map[string]any) {
		t.Run("snapshot-"+key, func(t *testing.T) {
			value := validStartupFixture(t)
			delete(value["current"].(map[string]any), key)
			if _, err := decodeStartupObservation(value); err == nil {
				t.Fatal("missing snapshot field accepted")
			}
		})
	}
}
func TestStartupFinalSafetyAndContinuity(t *testing.T) {
	observation, err := decodeStartupObservation(validStartupFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	loads := startupLoadSnapshot{Blank: 1, Controlled: 1}
	initial := startupSample{Observation: observation, LoadsBefore: loads, LoadsAfter: loads}
	cases := []struct {
		name   string
		mutate func(*startupSample)
	}{
		{"unsafe", func(s *startupSample) { s.Observation.Current.Unsafe = true }},
		{"known-modal-still-present", func(s *startupSample) { s.Observation.Current.Modals = 1 }},
		{"errors", func(s *startupSample) { s.Observation.Current.Errors = 1 }},
		{"rejections", func(s *startupSample) { s.Observation.Current.Rejections = 1 }},
		{"unknown-errors", func(s *startupSample) { s.Observation.Current.UnknownErrors = 1 }},
		{"unknown-caught-failure", func(s *startupSample) { s.Observation.UnknownFailures = 1 }},
		{"document-replaced", func(s *startupSample) { s.Observation.Current.DocumentID = "00000000-0000-4000-8000-000000000002" }},
		{"reload", func(s *startupSample) { s.LoadsAfter.Controlled++ }},
		{"foreign-load", func(s *startupSample) { s.LoadsAfter.Other++ }},
		{"initial-failed", func(s *startupSample) { s.Observation.InitialPreparationPassed = false }},
	}
	if ok, reasons := evaluateStartupSamples([]startupSample{initial, initial}); !ok {
		t.Fatalf("safe fixture failed: %v", reasons)
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			final := initial
			test.mutate(&final)
			if ok, reasons := evaluateStartupSamples([]startupSample{initial, final}); ok || len(reasons) == 0 {
				t.Fatal("unsafe observation accepted")
			}
			if !initial.Observation.InitialPreparationPassed {
				t.Fatal("final state changed initial preparation")
			}
		})
	}
}
func TestStartupObservationAnonymousPersistence(t *testing.T) {
	value := validStartupFixture(t)
	value["message"] = "PRIVATE https://private.invalid/token"
	value["current"].(map[string]any)["url"] = "PRIVATE"
	observation, err := decodeStartupObservation(value)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "PRIVATE") {
		t.Fatal("unknown fields escaped whitelist")
	}
	if category := startupErrorCategory(errors.New("PRIVATE https://private.invalid/token")); category != "unknown" {
		t.Fatal("unknown failure was swallowed")
	}
	if category := startupErrorCategory(nil); category != "none" {
		t.Fatal("nil failure misclassified")
	}
	value["current"].(map[string]any)["documentId"] = "PRIVATE https://private.invalid/token"
	if _, err := decodeStartupObservation(value); err == nil {
		t.Fatal("non-anonymous identity accepted")
	}
}
