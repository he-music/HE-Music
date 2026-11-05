package main

import (
	"context"
	"encoding/json"
	"math"
	"testing"
)

func lyricsTestState(t *testing.T) (*lyricsState, context.Context) {
	t.Helper()
	s := &lyricsState{}
	ctx := context.WithValue(context.Background(), testContextKey{}, "main")
	if _, err := s.begin(ctx); err != nil {
		t.Fatal(err)
	}
	return s, ctx
}

func lyricsTestSnapshot(epoch, seq uint64, track string) LyricsSnapshot {
	roman := "koe"
	return LyricsSnapshot{
		Epoch: epoch, Seq: seq, TrackKey: track, PlayName: "Synthetic song",
		ArtistName: "Synthetic artist", PositionMs: 1250.5, OffsetMs: -175, Rate: 1,
		LrcData: []LyricsLine{{
			StartTime: 900, EndTime: 2100, TranslatedLyric: "声音", RomanLyric: "koe",
			IsBG: true, IsDuet: true, Words: []LyricsWord{{StartTime: 1000, EndTime: 2000, Word: "声", RomanWord: &roman}},
		}},
		YrcData: []LyricsLine{},
	}
}

func TestLyricsPolicyOwnershipAndEpoch(t *testing.T) {
	s, ctx := lyricsTestState(t)
	other := context.WithValue(context.Background(), testContextKey{}, "other")
	for _, test := range []struct {
		name                    string
		ctx                     context.Context
		epoch                   uint64
		main, child, allowChild bool
		accepted                bool
	}{
		{"main", ctx, 1, true, false, false, true},
		{"unrelated page", ctx, 1, false, false, true, false},
		{"different context", other, 1, true, false, false, false},
		{"exact child", other, 1, false, true, true, true},
		{"child publishing", other, 1, false, true, false, false},
		{"old epoch", ctx, 0, true, false, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if accepted := s.authorize(test.ctx, test.epoch, test.main, test.child, test.allowChild) == nil; accepted != test.accepted {
				t.Fatalf("accepted=%v", accepted)
			}
		})
	}
	generation := s.open()
	if !s.close(generation, "") {
		t.Fatal("close failed")
	}
	s.revoke()
	if err := s.authorize(ctx, 1, true, false, false); err == nil || s.snapshot != nil {
		t.Fatal("revoked owner accepted")
	}
	session, err := s.begin(ctx)
	if err != nil || session.Epoch != 2 {
		t.Fatal(session, err)
	}
	if err := s.authorize(ctx, 1, true, false, false); err == nil {
		t.Fatal("old teardown could revoke new session")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.begin(cancelled); err == nil {
		t.Fatal("cancelled owner accepted")
	}
}

func TestLyricsPolicyReadyAttachGenerationAndReopen(t *testing.T) {
	for _, readyFirst := range []bool{true, false} {
		s, _ := lyricsTestState(t)
		first := s.open()
		requireTestEqual(t, s.showable(first), false)
		requireTestEqual(t, s.window.Visible, false)
		requireTestEqual(t, s.window.Pending, true)
		requireTestEqual(t, s.window.Locked, false)
		requireTestEqual(t, s.window.HoverUnlock, false)
		if readyFirst {
			s.ready = true
		} else {
			s.attached = true
		}
		if s.showable(first) {
			t.Fatal("one handshake half showed window")
		}
		s.ready, s.attached = true, true
		if !s.showable(first) {
			t.Fatal("completed handshake did not allow showing")
		}
		s.shown()
		if !s.window.Visible || s.window.Pending || s.showable(first) {
			t.Fatal("showing was not idempotent")
		}
		if !s.close(first, "") || s.window.Visible || s.window.Pending || s.close(first, "late failure") {
			t.Fatal("close was not synchronous/idempotent")
		}
		second := s.open()
		if s.current(first) || s.showable(first) || s.close(first, "late closed") || !s.current(second) {
			t.Fatal("old native callback affected new window")
		}
		if !s.close(second, "attach-timeout") || s.window.Failure != "attach-timeout" {
			t.Fatal("failed handshake not reported")
		}
		third := s.open()
		if !s.current(third) || s.window.Failure != "" {
			t.Fatal("failure prevented reopening")
		}
	}
}

func TestLyricsPolicySnapshotClockAttachAndTrackIsolation(t *testing.T) {
	s, _ := lyricsTestState(t)
	if s.attachment().Snapshot != nil {
		t.Fatal("fabricated initial snapshot")
	}
	if err := s.publishClock(LyricsClock{Epoch: 1, Seq: 1, TrackKey: "a", Rate: 1}); err == nil {
		t.Fatal("clock without snapshot accepted")
	}
	snapshot := lyricsTestSnapshot(1, 1, "a")
	if err := s.publishSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.LrcData[0].Words[0].Word = "mutated"
	*snapshot.LrcData[0].Words[0].RomanWord = "mutated"
	clock := LyricsClock{Epoch: 1, Seq: 2, TrackKey: "a", Playing: true, PositionMs: 5000, OffsetMs: -175, Rate: 1.5}
	if err := s.publishClock(clock); err != nil {
		t.Fatal(err)
	}
	attachment := s.attachment()
	if attachment.Snapshot.Seq != 2 || attachment.Snapshot.PositionMs != 5000 ||
		attachment.Snapshot.OffsetMs != -175 || attachment.Snapshot.Rate != 1.5 || !attachment.Snapshot.Playing ||
		attachment.Snapshot.LrcData[0].Words[0].Word != "声" || *attachment.Snapshot.LrcData[0].Words[0].RomanWord != "koe" {
		t.Fatal("Attach lost latest clock, units or typed lyric fields", attachment.Snapshot)
	}
	attachment.Snapshot.LrcData[0].Words[0].Word = "mutated return"
	if s.snapshot.LrcData[0].Words[0].Word != "声" {
		t.Fatal("Attach leaked mutable cache")
	}
	if err := s.publishSnapshot(lyricsTestSnapshot(1, 3, "b")); err != nil {
		t.Fatal(err)
	}
	clock.Seq = 4
	if err := s.publishClock(clock); err == nil {
		t.Fatal("clock for old track accepted")
	}
	clock.TrackKey, clock.Epoch = "b", 0
	if err := s.publishClock(clock); err == nil {
		t.Fatal("old epoch accepted")
	}
	clock.Epoch, clock.Seq = 1, 3
	if err := s.publishClock(clock); err == nil {
		t.Fatal("duplicate seq accepted")
	}
	if err := s.publishSnapshot(lyricsTestSnapshot(1, 2, "a")); err == nil {
		t.Fatal("late old snapshot accepted")
	}
}

func TestLyricsPolicyRejectsInvalidNumbers(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), float64(lyricsMaxSequence) + 1} {
		s, _ := lyricsTestState(t)
		snapshot := lyricsTestSnapshot(1, 1, "a")
		snapshot.PositionMs = value
		if err := s.publishSnapshot(snapshot); err == nil {
			t.Fatal("invalid position accepted", value)
		}
		snapshot = lyricsTestSnapshot(1, 1, "a")
		snapshot.LrcData[0].Words[0].EndTime = value
		if err := s.publishSnapshot(snapshot); err == nil {
			t.Fatal("invalid word time accepted", value)
		}
	}
	for _, rate := range []float64{0, -1, 17, math.NaN()} {
		s, _ := lyricsTestState(t)
		snapshot := lyricsTestSnapshot(1, 1, "a")
		snapshot.Rate = rate
		if err := s.publishSnapshot(snapshot); err == nil {
			t.Fatal("invalid rate accepted", rate)
		}
	}
}

func TestLyricsPolicyCommandWhitelistAndTrack(t *testing.T) {
	s, _ := lyricsTestState(t)
	for _, action := range []LyricsAction{LyricsPrevious, LyricsToggle, LyricsNext} {
		if err := s.validateCommand(LyricsCommand{Epoch: 1, Action: action}); err == nil {
			t.Fatal("playback command without song accepted")
		}
	}
	if err := s.publishSnapshot(lyricsTestSnapshot(1, 1, "a")); err != nil {
		t.Fatal(err)
	}
	for _, action := range []LyricsAction{LyricsPrevious, LyricsToggle, LyricsNext, LyricsShowMain, LyricsOpenSettings} {
		if err := s.validateCommand(LyricsCommand{Epoch: 1, TrackKey: "a", Action: action}); err != nil {
			t.Fatal(action, err)
		}
	}
	for _, command := range []LyricsCommand{
		{Epoch: 1, TrackKey: "a", Action: "arbitrary-channel"},
		{Epoch: 0, TrackKey: "a", Action: LyricsToggle},
		{Epoch: 1, TrackKey: "old", Action: LyricsToggle},
	} {
		if err := s.validateCommand(command); err == nil {
			t.Fatal("invalid command accepted", command)
		}
	}
}

func TestLyricsPolicyBoundsUseRealWorkAreas(t *testing.T) {
	areas := []LyricsBounds{{X: -1800, Y: -200, Width: 1600, Height: 1000}, {X: 200, Y: 50, Width: 1920, Height: 1080}}
	for _, test := range []struct {
		name string
		in   LyricsBounds
		want LyricsBounds
	}{
		{"negative origin", LyricsBounds{-1750, -150, 800, 180}, LyricsBounds{-1750, -150, 800, 180}},
		{"screen gap", LyricsBounds{-100, 50, 800, 180}, LyricsBounds{200, 50, 800, 180}},
		{"disconnected display", LyricsBounds{6000, 6000, 800, 180}, LyricsBounds{1320, 950, 800, 180}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := fitLyricsBounds(test.in, areas)
			if err != nil || got != test.want {
				t.Fatal(got, err, "want", test.want)
			}
		})
	}
	got, err := fitLyricsBounds(LyricsBounds{Width: 1400, Height: 360}, []LyricsBounds{{X: 20, Y: 30, Width: 500, Height: 100}})
	if err != nil || got != (LyricsBounds{20, 30, 640, 140}) {
		t.Fatal("small screen must retain reachable top-left", got, err)
	}
	for _, bounds := range []LyricsBounds{{Width: 639, Height: 180}, {Width: 800, Height: 139}, {Width: 1401, Height: 180}, {X: 10000001, Width: 800, Height: 180}} {
		if _, err := fitLyricsBounds(bounds, areas); err == nil {
			t.Fatal("invalid bounds accepted", bounds)
		}
	}
	if _, err := fitLyricsBounds(LyricsBounds{Width: 800, Height: 180}, nil); err == nil {
		t.Fatal("missing displays accepted")
	}
}

func TestLyricsContractTypedJSON(t *testing.T) {
	encoded, err := json.Marshal(lyricsTestSnapshot(1, 1, "a"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded LyricsSnapshot
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	line := decoded.LrcData[0]
	if line.TranslatedLyric != "声音" || line.RomanLyric != "koe" || !line.IsBG || !line.IsDuet ||
		line.StartTime != 900 || line.Words[0].StartTime != 1000 || *line.Words[0].RomanWord != "koe" || decoded.OffsetMs != -175 {
		t.Fatal("typed lyric fields or millisecond offset lost", decoded)
	}
}
