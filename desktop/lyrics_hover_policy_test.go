package main

import (
	"math"
	"reflect"
	"testing"
)

func TestLyricsHoverUnlockBodyStaysClickThrough(t *testing.T) {
	bounds := LyricsBounds{X: -1000, Y: 100, Width: 800, Height: 200}
	region := &LyricsUnlockRegion{X: .8, Y: .05, Width: .045, Height: .18}
	x, y := -1100, 110
	active := true
	var scheduled []func()
	var hover, input []bool
	cancelled, samples := 0, 0
	w := &lyricsHoverWatcher{
		current:  func() bool { return active },
		sample:   func() (LyricsBounds, int, int, *LyricsUnlockRegion) { samples++; return bounds, x, y, region },
		schedule: func(tick func()) func() { scheduled = append(scheduled, tick); return func() { cancelled++ } },
		onHover:  func(value bool) { hover = append(hover, value) },
		onInput:  func(value bool) { input = append(input, value) },
	}
	w.start()
	x, y = -900, 180 // Enter the lyric body: reveal the button, but keep click-through.
	scheduled[len(scheduled)-1]()
	if !reflect.DeepEqual(hover, []bool{true}) || len(input) != 0 {
		t.Fatal(hover, input)
	}
	scheduled[len(scheduled)-1]()
	if len(hover) != 1 {
		t.Fatal("stationary hover republished state")
	}
	x, y = -350, 120 // Actual normalized unlock button.
	scheduled[len(scheduled)-1]()
	if !reflect.DeepEqual(input, []bool{true}) {
		t.Fatal(input)
	}
	x, y = -900, 180
	scheduled[len(scheduled)-1]()
	if !reflect.DeepEqual(input, []bool{true, false}) {
		t.Fatal("body stopped passing through", input)
	}
	x = -1100
	scheduled[len(scheduled)-1]()
	if !reflect.DeepEqual(hover, []bool{true, false}) {
		t.Fatal(hover)
	}
	oldTick := scheduled[len(scheduled)-1]
	w.stop()
	before := samples
	oldTick()
	if samples != before || cancelled != 1 {
		t.Fatal("stopped tick remained active")
	}
	w.start()
	before = samples
	oldTick()
	if samples != before {
		t.Fatal("old lock tick revived after relock")
	}
	active = false
	scheduled[len(scheduled)-1]()
	if w.cancel != nil {
		t.Fatal("inactive owner retained scheduled work")
	}
}

func TestLyricsHoverUnlockRegionValidation(t *testing.T) {
	bounds := LyricsBounds{Width: 800, Height: 200}
	good := LyricsUnlockRegion{X: .8, Y: .05, Width: .045, Height: .18}
	if !validLyricsUnlockRegion(good, bounds) {
		t.Fatal("actual button rejected")
	}
	for _, region := range []LyricsUnlockRegion{
		{}, {X: -.1, Y: .05, Width: .04, Height: .1},
		{X: .99, Y: .05, Width: .04, Height: .1},
		{X: .8, Y: .05, Width: .2, Height: .18},
		{X: .8, Y: .05, Width: .045, Height: .5},
		{X: math.NaN(), Y: .05, Width: .045, Height: .18},
		{X: .8, Y: .05, Width: math.Inf(1), Height: .18},
	} {
		if validLyricsUnlockRegion(region, bounds) {
			t.Fatalf("accepted invalid region: %+v", region)
		}
	}
}

func TestLyricsHoverUnlockWithoutRegionNeverCapturesBody(t *testing.T) {
	captures := 0
	w := &lyricsHoverWatcher{
		current: func() bool { return true },
		sample: func() (LyricsBounds, int, int, *LyricsUnlockRegion) {
			return LyricsBounds{Width: 800, Height: 180}, 10, 10, nil
		},
		schedule: func(func()) func() { return func() {} },
		onHover:  func(bool) {},
		onInput: func(interactive bool) {
			if interactive {
				captures++
			}
		},
	}
	w.start()
	w.stop()
	if captures != 0 {
		t.Fatal("unregistered region captured desktop input")
	}
}
