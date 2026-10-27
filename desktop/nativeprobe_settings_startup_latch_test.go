//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"encoding/json"
	"testing"
)

func safeStartupLatchSample(t *testing.T) startupSample {
	t.Helper()
	value := validStartupFixture(t)
	value["unsafeSurfaceObserved"] = false
	observation, err := decodeStartupObservation(value)
	if err != nil {
		t.Fatal(err)
	}
	loads := startupLoadSnapshot{Blank: 1, Controlled: 1}
	return startupSample{Observation: observation, LoadsBefore: loads, LoadsAfter: loads}
}

func TestStartupUnsafeCurrentCannotRecover(t *testing.T) {
	for _, field := range []string{"unsafe", "unknown", "drawers", "settings"} {
		t.Run(field, func(t *testing.T) {
			first := safeStartupLatchSample(t)
			middle := first
			switch field {
			case "unsafe":
				middle.Observation.Current.Unsafe = true
			case "unknown":
				middle.Observation.Current.Unknown = 1
			case "drawers":
				middle.Observation.Current.Drawers = 1
			case "settings":
				middle.Observation.Current.Settings = 1
			}
			middle.Observation.Current.Empty = false
			if ok, reasons := evaluateStartupSamples([]startupSample{first, middle, first}); ok || len(reasons) == 0 {
				t.Fatal("observed unsafe current recovered after a safe sample")
			}
		})
	}
}

func TestStartupUnsafeHistoryCannotRecover(t *testing.T) {
	for _, field := range []string{"unsafe", "unknown", "drawers", "settings"} {
		t.Run(field, func(t *testing.T) {
			first := safeStartupLatchSample(t)
			middle := first
			history := first.Observation.Current
			switch field {
			case "unsafe":
				history.Unsafe = true
			case "unknown":
				history.Unknown = 1
			case "drawers":
				history.Drawers = 1
			case "settings":
				history.Settings = 1
			}
			history.Empty = false
			middle.Observation.Snapshots = []startupSnapshotDTO{history}
			if ok, reasons := evaluateStartupSamples([]startupSample{first, middle, first}); ok || len(reasons) == 0 {
				t.Fatal("history-only unsafe surface recovered after a safe sample")
			}
		})
	}
}

func TestStartupUnsafeLatchTypedAndRequired(t *testing.T) {
	t.Run("persist-and-reject-latched-safe-current", func(t *testing.T) {
		value := validStartupFixture(t)
		value["unsafeSurfaceObserved"] = true
		observation, err := decodeStartupObservation(value)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(observation)
		if err != nil {
			t.Fatal(err)
		}
		var persisted map[string]json.RawMessage
		if json.Unmarshal(encoded, &persisted) != nil || string(persisted["unsafeSurfaceObserved"]) != "true" {
			t.Fatal("typed persistence lost the unsafe latch")
		}
		if startupSurfaceSafe(observation) {
			t.Fatal("latched unsafe surface passed short-poll safety")
		}
		first := safeStartupLatchSample(t)
		middle := first
		middle.Observation = observation
		if ok, _ := evaluateStartupSamples([]startupSample{first, middle, first}); ok {
			t.Fatal("typed latch was ignored between safe samples")
		}
	})
	for _, value := range []any{nil, "false"} {
		t.Run("missing-or-invalid-latch", func(t *testing.T) {
			fixture := validStartupFixture(t)
			if value == nil {
				delete(fixture, "unsafeSurfaceObserved")
			} else {
				fixture["unsafeSurfaceObserved"] = value
			}
			if _, err := decodeStartupObservation(fixture); err == nil {
				t.Fatal("missing or invalid latch accepted")
			}
		})
	}
}

func TestStartupKnownLeaveDoesNotLatchUnsafe(t *testing.T) {
	first := safeStartupLatchSample(t)
	known := first
	known.Observation.Current.Modals = 1
	known.Observation.Current.Empty = false
	known.Observation.Snapshots = []startupSnapshotDTO{known.Observation.Current}
	if ok, reasons := evaluateStartupSamples([]startupSample{first, known, first}); !ok {
		t.Fatalf("known agreement/login leave was rejected: %v", reasons)
	}
}
