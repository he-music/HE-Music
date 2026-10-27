package main

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

type fakeSystemMedia struct {
	info         mygo.NowPlayingInfo
	showing      bool
	infoReads    int
	sets         []mygo.NowPlayingInfo
	playback     []time.Duration
	callbacks    []func(mygo.MediaCommand, time.Duration)
	clears, offs int
}

func (f *fakeSystemMedia) Set(info mygo.NowPlayingInfo) {
	f.sets = append(f.sets, info)
	f.info, f.showing = info, true
}
func (f *fakeSystemMedia) Info() (mygo.NowPlayingInfo, bool) {
	f.infoReads++
	return f.info, f.showing
}
func (f *fakeSystemMedia) SetPlayback(state mygo.PlaybackState, position time.Duration) {
	f.playback = append(f.playback, position)
	f.info.State, f.info.Position = state, position
}
func (f *fakeSystemMedia) Clear() { f.clears++; f.showing = false }
func (f *fakeSystemMedia) OnCommand(fn func(mygo.MediaCommand, time.Duration)) func() {
	f.callbacks = append(f.callbacks, fn)
	return func() { f.offs++ }
}

type fakeSystemPower struct {
	leases         map[int]bool
	display        bool
	next, releases int
}

func (f *fakeSystemPower) KeepAwake(_ string, display bool) func() {
	f.next++
	id := f.next
	f.leases[id] = true
	f.display = display
	return func() { delete(f.leases, id); f.releases++ }
}
func newSystemMediaTest() (*systemMediaState, *fakeSystemMedia, *fakeSystemPower, *[]SystemMediaCommand) {
	media := &fakeSystemMedia{}
	power := &fakeSystemPower{leases: map[int]bool{}}
	events := &[]SystemMediaCommand{}
	state := &systemMediaState{media: media, power: power, valid: func(context.Context) bool { return true }, emit: func(event SystemMediaCommand) { *events = append(*events, event) }}
	return state, media, power, events
}
func systemMediaTestTrack() SystemMediaTrack {
	return SystemMediaTrack{ID: "online-song", Source: "online", Title: "Synthetic title", Artist: "Artist", Album: "Album", DurationMS: 10000, State: "paused", Rate: 1, CanNext: true, CanPrevious: true}
}
func TestSystemMediaInitialDisabledAndOwnership(t *testing.T) {
	s, media, power, _ := newSystemMediaTest()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if len(media.sets) != 0 || len(media.callbacks) != 0 || power.next != 0 {
		t.Fatal("construction touched backend")
	}
	s.valid = func(context.Context) bool { return false }
	if _, err := s.configure(ctx, 0, true, true); err == nil {
		t.Fatal("failed readiness accepted")
	}
	s.valid = func(context.Context) bool { return true }
	status, err := s.configure(ctx, 0, false, false)
	if err != nil || status.MetadataRequested || status.KeepAwakeRequested || status.MediaEnabled {
		t.Fatal(status, err)
	}
	if err := s.set(ctx, status.Generation, 1, systemMediaTestTrack()); err == nil {
		t.Fatal("disabled set accepted")
	}
	other := context.WithValue(ctx, struct{}{}, 1)
	if _, err := s.configure(other, status.Generation, true, true); err == nil {
		t.Fatal("other owner accepted")
	}
	cancel()
	if _, err := s.configure(ctx, status.Generation, true, true); err == nil {
		t.Fatal("cancelled context accepted")
	}
	s.revoke()
	s.revoke()
	if power.next != 0 || media.clears != 0 {
		t.Fatal("disabled acquired resources")
	}
}
func TestSystemMediaTrackCommandsAndStaleSnapshots(t *testing.T) {
	s, media, _, events := newSystemMediaTest()
	ctx := context.Background()
	status, _ := s.configure(ctx, 0, true, false)
	gen := status.Generation
	track := systemMediaTestTrack()
	if err := s.set(ctx, gen, 1, track); err != nil {
		t.Fatal(err)
	}
	info := media.sets[0]
	if info.State != mygo.PlaybackPaused || info.Duration != 10*time.Second || info.Artist != track.Artist || info.Album != track.Album || info.Commands&mygo.MediaStop != 0 {
		t.Fatal(info)
	}
	callback := media.callbacks[0]
	for _, cmd := range []mygo.MediaCommand{mygo.MediaPlay, mygo.MediaPause, mygo.MediaPrevious, mygo.MediaNext, mygo.MediaSeek} {
		callback(cmd, 0)
	}
	callback(mygo.MediaSeek, 10*time.Second)
	if len(*events) != 6 || (*events)[4].PositionMS != 0 || (*events)[5].PositionMS != 10000 {
		t.Fatal(*events)
	}
	callback(mygo.MediaSeek, -1)
	callback(mygo.MediaSeek, 10*time.Second+1)
	callback(mygo.MediaStop, 0)
	if len(*events) != 6 {
		t.Fatal("invalid command emitted")
	}
	if err := s.playback(ctx, gen, 1, track.ID, "playing", 0); err != nil {
		t.Fatal(err)
	}
	if media.playback[0] != 0 {
		t.Fatal("seek zero lost")
	}
	track.ID = "new-song"
	if err := s.set(ctx, gen, 2, track); err != nil {
		t.Fatal(err)
	}
	callback(mygo.MediaPlay, 0)
	if len(*events) != 6 {
		t.Fatal("old track callback emitted")
	}
	if err := s.set(ctx, gen, 1, systemMediaTestTrack()); err == nil {
		t.Fatal("stale snapshot accepted")
	}
	if err := s.playback(ctx, gen, 1, "online-song", "playing", 0); err == nil {
		t.Fatal("stale playback accepted")
	}
	next, _ := s.configure(ctx, gen, true, false)
	media.callbacks[1](mygo.MediaPlay, 0)
	if len(*events) != 6 || next.Generation == gen {
		t.Fatal("stale generation emitted")
	}
	if err := s.clear(ctx, gen, 3); err == nil {
		t.Fatal("stale clear accepted")
	}
}
func TestSystemMediaMetadataCleanupAndUnknownDuration(t *testing.T) {
	s, media, _, events := newSystemMediaTest()
	ctx := context.Background()
	status, _ := s.configure(ctx, 0, true, false)
	gen := status.Generation
	track := systemMediaTestTrack()
	track.DurationMS = 0
	track.PositionMS = 2500
	track.CanNext = false
	track.CanPrevious = false
	if err := s.set(ctx, gen, 1, track); err != nil {
		t.Fatal(err)
	}
	if media.sets[0].Commands != mygo.MediaPlay|mygo.MediaPause {
		t.Fatal("unknown duration advertised seek or navigation")
	}
	media.callbacks[0](mygo.MediaSeek, 0)
	if len(*events) != 0 {
		t.Fatal("unknown duration seek emitted")
	}
	track.Source = "local"
	if err := s.set(ctx, gen, 2, track); err != nil || s.showing || media.clears != 1 || media.offs != 1 {
		t.Fatal("local metadata retained", err)
	}
	track = systemMediaTestTrack()
	if err := s.set(ctx, gen, 3, track); err != nil {
		t.Fatal(err)
	}
	track.State = ""
	if err := s.set(ctx, gen, 4, track); err == nil || s.showing {
		t.Fatal("invalid state retained metadata")
	}
	if err := s.set(ctx, gen, 5, systemMediaTestTrack()); err != nil {
		t.Fatal(err)
	}
	if err := s.clear(ctx, gen, 6); err != nil || s.showing {
		t.Fatal("clear failed", err)
	}
	if err := s.set(ctx, gen, 5, systemMediaTestTrack()); err == nil {
		t.Fatal("late metadata resurrected")
	}
}
func TestSystemMediaNumericBoundaries(t *testing.T) {
	s, media, _, _ := newSystemMediaTest()
	ctx := context.Background()
	status, _ := s.configure(ctx, 0, true, false)
	gen := status.Generation
	for i, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1, 9000000000001} {
		track := systemMediaTestTrack()
		track.DurationMS = value
		if err := s.set(ctx, gen, uint64(i+1), track); err == nil {
			t.Fatalf("accepted duration %v", value)
		}
	}
	if err := s.set(ctx, gen, 6, systemMediaTestTrack()); err != nil {
		t.Fatal(err)
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), -1, 10001, 9000000000001} {
		if err := s.playback(ctx, gen, 6, "online-song", "paused", value); err == nil {
			t.Fatalf("accepted position %v", value)
		}
	}
	if err := s.playback(ctx, gen, 6, "online-song", "paused", 10000); err != nil {
		t.Fatal(err)
	}
	if len(media.playback) != 1 || media.playback[0] != 10*time.Second {
		t.Fatal(media.playback)
	}
}
func TestSystemMediaIndependentPowerLeaseAndRepeatedCleanup(t *testing.T) {
	s, media, power, events := newSystemMediaTest()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	releaseOther := power.KeepAwake("other service", false)
	status, _ := s.configure(ctx, 0, true, true)
	gen := status.Generation
	if !status.KeepAwakeRequested || !power.display || len(power.leases) != 2 {
		t.Fatal("display lease missing")
	}
	if err := s.set(ctx, gen, 1, systemMediaTestTrack()); err != nil {
		t.Fatal(err)
	}
	callback := media.callbacks[0]
	status, _ = s.configure(ctx, gen, false, true)
	if !status.KeepAwakeRequested || power.releases != 0 || media.clears != 1 {
		t.Fatal("media toggle released power")
	}
	callback(mygo.MediaPlay, 0)
	if len(*events) != 0 {
		t.Fatal("disabled callback emitted")
	}
	status, _ = s.configure(ctx, status.Generation, false, false)
	if status.KeepAwakeRequested || power.releases != 1 || !power.leases[1] {
		t.Fatal("other lease released")
	}
	status, _ = s.configure(ctx, status.Generation, true, true)
	if err := s.set(ctx, status.Generation, 1, systemMediaTestTrack()); err != nil {
		t.Fatal(err)
	}
	callback = media.callbacks[1]
	cancel()
	callback(mygo.MediaPlay, 0)
	if len(*events) != 0 {
		t.Fatal("cancelled callback emitted")
	}
	s.revoke()
	s.revoke()
	if power.releases != 2 || media.clears != 2 || media.offs != 2 || !power.leases[1] {
		t.Fatal("cleanup not scoped/idempotent")
	}
	releaseOther()
}
func TestSystemMediaTeardownCannotReleaseNewOwner(t *testing.T) {
	s, _, power, _ := newSystemMediaTest()
	ctx := context.Background()
	status, _ := s.configure(ctx, 0, true, true)
	if err := s.teardown(ctx, status.Generation); err != nil {
		t.Fatal(err)
	}
	if err := s.teardown(ctx, status.Generation); err != nil {
		t.Fatal("repeat teardown", err)
	}
	newer, _ := s.configure(ctx, 0, false, true)
	if err := s.teardown(ctx, status.Generation); err == nil {
		t.Fatal("old teardown accepted")
	}
	if !s.status().KeepAwakeRequested || s.generation != newer.Generation || power.releases != 1 {
		t.Fatal("old owner released new lease")
	}
}
