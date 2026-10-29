package main

import (
	"context"
	"testing"
)

func TestLyricsOptionsSnapshotCacheAndClock(t *testing.T) {
	state, _ := lyricsTestState(t)
	options := defaultLyricsOptions()
	options.Font.Family, options.Font.Size = "测试字体", 48
	options.Position, options.ShowTran = "center", false
	snapshot := lyricsTestSnapshot(state.epoch, 1, "track")
	snapshot.Options = &options
	if err := state.publishSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	options.Font.Size = 96
	if state.snapshot.Options.Font.Size != 48 {
		t.Fatal("caller changed cached font size")
	}
	attachment := state.attachment()
	attachment.Snapshot.Options.Font.Family = "mutated"
	if state.snapshot.Options.Font.Family != "测试字体" {
		t.Fatal("attachment changed cached font")
	}
	if err := state.publishClock(LyricsClock{Epoch: state.epoch, Seq: 2, TrackKey: "track", Rate: 1, PositionMs: 1000}); err != nil {
		t.Fatal(err)
	}
	if state.snapshot.Options.Font.Size != 48 || state.snapshot.Options.ShowTran {
		t.Fatal("clock replaced options")
	}
	if _, err := state.begin(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.snapshot != nil {
		t.Fatal("new epoch retained old options")
	}
}

func TestLyricsOptionsInvalidSnapshotRetainsSequence(t *testing.T) {
	state, _ := lyricsTestState(t)
	initial := lyricsTestSnapshot(state.epoch, 1, "track")
	if err := state.publishSnapshot(initial); err != nil {
		t.Fatal(err)
	}
	if state.snapshot.Options == nil || *state.snapshot.Options != defaultLyricsOptions() {
		t.Fatal("missing legacy defaults")
	}
	invalid := lyricsTestSnapshot(state.epoch, 2, "track")
	options := defaultLyricsOptions()
	options.Font.Size = 97
	invalid.Options = &options
	if err := state.publishSnapshot(invalid); err == nil {
		t.Fatal("accepted oversized font")
	}
	if state.seq != 1 || *state.snapshot.Options != defaultLyricsOptions() {
		t.Fatal("invalid options changed cached state")
	}
	options.Font.Size = 48
	if err := state.publishSnapshot(invalid); err != nil {
		t.Fatalf("invalid snapshot consumed sequence: %v", err)
	}
}
