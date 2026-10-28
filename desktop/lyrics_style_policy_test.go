package main

import (
	"context"
	"testing"
)

func TestLyricsStyleSnapshotCacheAndClock(t *testing.T) {
	state, _ := lyricsTestState(t)
	style := defaultLyricsStyle()
	style.PlayedColor = "#123456"
	style.TextBackgroundMask = true
	snapshot := lyricsTestSnapshot(state.epoch, 1, "track")
	snapshot.Style = &style
	if err := state.publishSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	style.PlayedColor = "#abcdef"
	if state.snapshot.Style.PlayedColor != "#123456" {
		t.Fatal("caller mutated cached style")
	}
	attachment := state.attachment()
	attachment.Snapshot.Style.ShadowColor = "#fff"
	if state.snapshot.Style.ShadowColor != defaultLyricsStyle().ShadowColor {
		t.Fatal("attachment mutated cached style")
	}
	clock := LyricsClock{Epoch: state.epoch, Seq: 2, TrackKey: "track", Rate: 1, PositionMs: 2000}
	if err := state.publishClock(clock); err != nil {
		t.Fatal(err)
	}
	if state.snapshot.Style.PlayedColor != "#123456" || !state.snapshot.Style.TextBackgroundMask {
		t.Fatal("clock replaced style")
	}
	if _, err := state.begin(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.snapshot != nil {
		t.Fatal("new epoch retained old style snapshot")
	}
}

func TestLyricsStyleInvalidSnapshotDoesNotReplaceCache(t *testing.T) {
	state, _ := lyricsTestState(t)
	initial := lyricsTestSnapshot(state.epoch, 1, "track")
	if err := state.publishSnapshot(initial); err != nil {
		t.Fatal(err)
	}
	if state.snapshot.Style == nil || *state.snapshot.Style != defaultLyricsStyle() {
		t.Fatal("legacy sender did not receive default style")
	}
	invalid := lyricsTestSnapshot(state.epoch, 2, "track")
	style := defaultLyricsStyle()
	style.ShadowColor = "url(https://fixture.invalid/private)"
	invalid.Style = &style
	if err := state.publishSnapshot(invalid); err == nil {
		t.Fatal("invalid style accepted")
	}
	if state.seq != 1 || *state.snapshot.Style != defaultLyricsStyle() {
		t.Fatal("invalid style changed cached state")
	}
	invalid.Style = nil
	invalid.Epoch--
	if err := state.publishSnapshot(invalid); err == nil {
		t.Fatal("old epoch accepted")
	}
}
