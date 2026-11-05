package main

import (
	"reflect"
	"testing"
)

func TestLyricsInputShapeLockAndRestore(t *testing.T) {
	var calls []string
	access := nativeLyricsInputAccess{
		validWindow: func(handle uintptr) bool { return handle == 42 },
		setShape: func(handle, region uintptr) {
			if handle != 42 {
				t.Fatal("changed another window")
			}
			switch region {
			case 7:
				calls = append(calls, "empty input")
			case 0:
				calls = append(calls, "normal input")
			default:
				t.Fatal("unexpected region")
			}
		},
		createRegion: func() uintptr { calls = append(calls, "create"); return 7 },
		regionStatus: func(region uintptr) int32 {
			if region != 7 {
				t.Fatal("invalid region status query")
			}
			return 0
		},
		destroyRegion: func(region uintptr) {
			if region != 7 {
				t.Fatal("invalid region cleanup")
			}
			calls = append(calls, "destroy")
		},
	}
	if err := applyNativeLyricsInputShape(42, true, access); err != nil {
		t.Fatal(err)
	}
	if err := applyNativeLyricsInputShape(42, false, access); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"create", "empty input", "destroy", "normal input"}) {
		t.Fatal(calls)
	}
}

func TestLyricsInputShapeFailureDoesNotCaptureOrDiscardInput(t *testing.T) {
	for _, mode := range []string{"invalid window", "missing allocator", "nil region", "allocation error"} {
		t.Run(mode, func(t *testing.T) {
			shaped, destroyed := 0, 0
			access := nativeLyricsInputAccess{
				validWindow: func(uintptr) bool { return mode != "invalid window" },
				setShape:    func(uintptr, uintptr) { shaped++ },
				createRegion: func() uintptr {
					if mode == "nil region" {
						return 0
					}
					return 7
				},
				regionStatus:  func(uintptr) int32 { return 1 },
				destroyRegion: func(uintptr) { destroyed++ },
			}
			if mode == "missing allocator" {
				access.createRegion = nil
			}
			if err := applyNativeLyricsInputShape(42, true, access); err == nil || shaped != 0 {
				t.Fatalf("failed lock was accepted: %v, changes=%d", err, shaped)
			}
			if mode == "allocation error" && destroyed != 1 {
				t.Fatal("failed Cairo region was leaked")
			}
		})
	}
}

func TestLyricsInputRestoreDoesNotDependOnRegionAllocation(t *testing.T) {
	shaped := false
	access := nativeLyricsInputAccess{
		validWindow: func(uintptr) bool { return true },
		setShape: func(handle, region uintptr) {
			shaped = handle == 42 && region == 0
		},
	}
	if err := applyNativeLyricsInputShape(42, false, access); err != nil || !shaped {
		t.Fatal("restoring normal input required a new region", err)
	}
}
