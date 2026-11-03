package main

import "testing"

func policyFixture() (nativeWebViewPolicyAccess, *bool, *int32) {
	gesture, acceleration := true, int32(1)
	access := nativeWebViewPolicyAccess{
		prepareTransparentBackground: func(view uintptr) error {
			if view != 3 {
				panic("background clearing escaped the lyrics view")
			}
			return nil
		},
		isWebView: func(widget uintptr) bool { return widget == 3 },
		children: func(widget uintptr) []uintptr {
			if widget == 1 {
				return []uintptr{0, 2}
			}
			if widget == 2 {
				return []uintptr{1, 3}
			}
			return nil
		},
		settings: func(widget uintptr) uintptr {
			if widget == 3 {
				return 4
			}
			return 0
		},
		requiresGesture: func(uintptr) bool { return gesture },
		setGesture: func(settings uintptr, required bool) {
			if settings == 4 {
				gesture = required
			}
		},
		acceleration: func(uintptr) int32 { return acceleration },
		setAcceleration: func(settings uintptr, policy int32) {
			if settings == 4 {
				acceleration = policy
			}
		},
	}
	return access, &gesture, &acceleration
}

func TestNativePlaybackPolicyPreservesMainRendering(t *testing.T) {
	access, gesture, acceleration := policyFixture()
	if err := applyNativePlaybackPolicy(1, access); err != nil {
		t.Fatal(err)
	}
	if *gesture || *acceleration != 1 {
		t.Fatal("playback policy did not preserve the main view's renderer")
	}
}

func TestNativeLyricsPolicyIsLocalToTheChildSettings(t *testing.T) {
	access, gesture, acceleration := policyFixture()
	*acceleration = 2 // Begin in the non-composited mode that left stale GTK frames.
	if err := applyNativeLyricsRenderingPolicy(1, access); err != nil {
		t.Fatal(err)
	}
	if !*gesture || *acceleration != 1 {
		t.Fatal("lyrics policy changed unrelated settings or did not enable compositing")
	}
}

func TestNativePoliciesVerifyReadbackAndMissingViews(t *testing.T) {
	access, _, acceleration := policyFixture()
	access.setGesture = func(uintptr, bool) {}
	if err := applyNativePlaybackPolicy(1, access); err == nil {
		t.Fatal("ignored failed playback policy setter")
	}
	*acceleration = 2
	access.setAcceleration = func(uintptr, int32) {}
	cleared := false
	access.prepareTransparentBackground = func(uintptr) error { cleared = true; return nil }
	if err := applyNativeLyricsRenderingPolicy(1, access); err == nil {
		t.Fatal("ignored failed rendering policy setter")
	}
	if !cleared {
		t.Fatal("failed acceleration policy disabled independent background clearing")
	}
	access.isWebView = func(uintptr) bool { return false }
	if _, err := nativeWebViewSettings(1, access); err == nil {
		t.Fatal("accepted a cyclic tree without a web view")
	}
	if _, err := nativeWebViewSettings(0, access); err == nil {
		t.Fatal("accepted a destroyed window")
	}
}

func TestTransparentDrawClearsDamageBeforeRestoringState(t *testing.T) {
	var calls []string
	access := nativeTransparentDrawAccess{
		save: func(uintptr) { calls = append(calls, "save") },
		setOperator: func(_ uintptr, operator int32) {
			if operator != 0 {
				t.Fatal("did not clear the damaged region")
			}
			calls = append(calls, "clear")
		},
		paint:   func(uintptr) { calls = append(calls, "paint") },
		restore: func(uintptr) { calls = append(calls, "restore") },
	}
	clearNativeTransparentBackground(4, access)
	if len(calls) != 4 || calls[0] != "save" || calls[1] != "clear" || calls[2] != "paint" || calls[3] != "restore" {
		t.Fatalf("unexpected draw sequence: %v", calls)
	}
	clearNativeTransparentBackground(0, access)
	if len(calls) != 4 {
		t.Fatal("attempted to draw with an invalid cairo context")
	}
}
