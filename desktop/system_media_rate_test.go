package main

import (
	"context"
	"math"
	"testing"

	"github.com/egoist/mygo"
)

func TestSystemMediaExplicitRateAndRejectedRatePreservesSnapshot(t *testing.T) {
	s, media, _, events := newSystemMediaTest()
	ctx := context.Background()
	status, err := s.configure(ctx, 0, true, false)
	if err != nil {
		t.Fatal(err)
	}
	track := systemMediaTestTrack()
	track.Rate = 1.5
	if err := s.set(ctx, status.Generation, 1, track); err != nil {
		t.Fatal(err)
	}
	if media.sets[0].Rate != 1.5 {
		t.Fatal("non-default rate lost")
	}
	callback := media.callbacks[0]
	for _, rate := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1), 16.01} {
		track.Rate = rate
		if err := s.set(ctx, status.Generation, 2, track); err == nil {
			t.Fatalf("accepted invalid rate %v", rate)
		}
		if !s.showing || s.revision != 1 || len(media.sets) != 1 || media.clears != 0 || media.offs != 0 {
			t.Fatal("rejected rate destroyed current snapshot")
		}
	}
	callback(mygo.MediaPlay, 0)
	if len(*events) != 1 {
		t.Fatal("valid callback invalidated")
	}
	if err := s.playback(ctx, status.Generation, 1, track.ID, "playing", 0); err != nil {
		t.Fatal(err)
	}
	if media.sets[0].Rate != 1.5 {
		t.Fatal("playback replaced rate")
	}
	track.Rate = 16
	if err := s.set(ctx, status.Generation, 2, track); err != nil || media.sets[1].Rate != 16 {
		t.Fatal("rate upper boundary rejected", err)
	}
	track.Rate = 0
	track.Source = "local"
	if err := s.set(ctx, status.Generation, 3, track); err != nil || s.showing {
		t.Fatal("unsupported metadata must clear independently of rate", err)
	}
}
