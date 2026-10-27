package main

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// All positions crossing the binding are milliseconds; HTMLAudio uses seconds.
type SystemMediaTrack struct {
	ID          string  `json:"id"`
	Source      string  `json:"source"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	DurationMS  float64 `json:"durationMs"`
	PositionMS  float64 `json:"positionMs"`
	State       string  `json:"state"`
	Rate        float64 `json:"rate"`
	CanPrevious bool    `json:"canPrevious"`
	CanNext     bool    `json:"canNext"`
}

type SystemMediaStatus struct {
	Generation         uint64 `json:"generation"`
	MediaEnabled       bool   `json:"mediaEnabled"`
	MetadataRequested  bool   `json:"metadataRequested"`
	KeepAwakeRequested bool   `json:"keepAwakeRequested"`
}

type SystemMediaCommand struct {
	Generation uint64  `json:"generation"`
	Revision   uint64  `json:"revision"`
	TrackID    string  `json:"trackId"`
	Action     string  `json:"action"`
	PositionMS float64 `json:"positionMs"`
}

type systemMediaBackend interface {
	Set(mygo.NowPlayingInfo)
	Info() (mygo.NowPlayingInfo, bool)
	SetPlayback(mygo.PlaybackState, time.Duration)
	Clear()
	OnCommand(func(mygo.MediaCommand, time.Duration)) func()
}
type systemPowerBackend interface{ KeepAwake(string, bool) func() }

// Like lifecycle/shortcuts, this state is exclusively used on the main thread.
// Fake backends keep tests and binding generation free of native registration.
type systemMediaState struct {
	owner              context.Context
	generation         uint64
	revision           uint64
	trackID            string
	duration           time.Duration
	commands           mygo.MediaCommand
	enabled            bool
	showing            bool
	off                func()
	releasePower       func()
	releasedOwner      context.Context
	releasedGeneration uint64
	media              systemMediaBackend
	power              systemPowerBackend
	valid              func(context.Context) bool
	emit               func(SystemMediaCommand)
}

func (s *systemMediaState) owns(ctx context.Context, generation uint64) bool {
	return s.owner != nil && s.owner == ctx && ctx.Err() == nil && s.generation == generation && s.valid(ctx)
}

func (s *systemMediaState) status() SystemMediaStatus {
	return SystemMediaStatus{s.generation, s.enabled, s.showing, s.releasePower != nil}
}

func (s *systemMediaState) clearMedia() {
	// Invalidate before native calls: an already queued callback must be harmless.
	s.trackID, s.duration, s.commands = "", 0, 0
	off := s.off
	s.off = nil
	if off != nil {
		off()
	}
	if s.showing {
		s.showing = false
		s.media.Clear()
	}
}

func (s *systemMediaState) revoke() {
	if s.owner == nil {
		return
	}
	s.releasedOwner, s.releasedGeneration = s.owner, s.generation
	s.owner = nil
	s.generation++
	s.enabled = false
	s.revision = 0
	s.clearMedia()
	release := s.releasePower
	s.releasePower = nil
	if release != nil {
		release()
	}
}

// Configure invalidates every previous media snapshot and callback. Power is
// independent: disabling media does not release an explicitly requested lease.
func (s *systemMediaState) configure(ctx context.Context, generation uint64, enabled, preventSleep bool) (SystemMediaStatus, error) {
	if ctx.Err() != nil || !s.valid(ctx) || (s.owner == nil && generation != 0) || (s.owner != nil && !s.owns(ctx, generation)) {
		return SystemMediaStatus{}, errors.New("system media owner or generation is no longer active")
	}
	s.generation++
	s.clearMedia()
	s.owner, s.enabled, s.revision = ctx, enabled, 0
	if preventSleep && s.releasePower == nil {
		s.releasePower = s.power.KeepAwake("HE-Music preventSleep", true)
	} else if !preventSleep && s.releasePower != nil {
		release := s.releasePower
		s.releasePower = nil
		release()
	}
	return s.status(), nil
}

func mediaMilliseconds(value float64) (time.Duration, error) {
	// A conservative exact bound prevents float conversion overflowing int64.
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 9000000000000 {
		return 0, errors.New("invalid media milliseconds")
	}
	return time.Duration(value * float64(time.Millisecond)), nil
}

func mediaPlayback(state string, positionMS float64, duration time.Duration) (mygo.PlaybackState, time.Duration, error) {
	position, err := mediaMilliseconds(positionMS)
	if err != nil {
		return 0, 0, err
	}
	if duration > 0 && position > duration {
		return 0, 0, errors.New("media position exceeds duration")
	}
	switch state {
	case "playing":
		return mygo.PlaybackPlaying, position, nil
	case "paused":
		return mygo.PlaybackPaused, position, nil
	case "stopped":
		return mygo.PlaybackStopped, position, nil
	default:
		return 0, 0, errors.New("explicit media playback state required")
	}
}

func (s *systemMediaState) set(ctx context.Context, generation, revision uint64, track SystemMediaTrack) error {
	if !s.owns(ctx, generation) || !s.enabled || revision == 0 || revision <= s.revision {
		return errors.New("system media snapshot is no longer active")
	}
	if track.Source == "online" && strings.TrimSpace(track.ID) != "" && strings.TrimSpace(track.Title) != "" &&
		(math.IsNaN(track.Rate) || math.IsInf(track.Rate, 0) || track.Rate <= 0 || track.Rate > 16) {
		return errors.New("explicit finite media rate must be greater than zero and at most 16")
	}
	// Invalid rates leave the current snapshot intact. Other newer snapshots
	// consume their revision and clear unsupported or malformed metadata.
	s.revision = revision
	s.clearMedia()
	if track.Source != "online" || strings.TrimSpace(track.ID) == "" || strings.TrimSpace(track.Title) == "" {
		return nil
	}
	duration, err := mediaMilliseconds(track.DurationMS)
	if err != nil {
		return err
	}
	state, position, err := mediaPlayback(track.State, track.PositionMS, duration)
	if err != nil {
		return err
	}
	commands := mygo.MediaPlay | mygo.MediaPause
	if track.CanPrevious {
		commands |= mygo.MediaPrevious
	}
	if track.CanNext {
		commands |= mygo.MediaNext
	}
	if duration > 0 {
		commands |= mygo.MediaSeek
	}
	s.trackID, s.duration, s.commands = track.ID, duration, commands
	s.off = s.media.OnCommand(func(command mygo.MediaCommand, pos time.Duration) {
		if !s.owns(ctx, generation) || !s.enabled || !s.showing || s.revision != revision || s.trackID != track.ID || s.commands&command == 0 {
			return
		}
		var action string
		switch command {
		case mygo.MediaPlay:
			action = "play"
		case mygo.MediaPause:
			action = "pause"
		case mygo.MediaPrevious:
			action = "previous"
		case mygo.MediaNext:
			action = "next"
		case mygo.MediaSeek:
			if duration <= 0 || pos < 0 || pos > duration {
				return
			}
			action = "seek"
		default:
			return
		}
		s.emit(SystemMediaCommand{generation, revision, track.ID, action, float64(pos) / float64(time.Millisecond)})
	})
	s.showing = true
	s.media.Set(mygo.NowPlayingInfo{Title: track.Title, Artist: track.Artist, Album: track.Album, Duration: duration, Position: position, State: state, Rate: track.Rate, Commands: commands})
	return nil
}

func (s *systemMediaState) playback(ctx context.Context, generation, revision uint64, trackID, state string, positionMS float64) error {
	if !s.owns(ctx, generation) || !s.showing || revision != s.revision || trackID != s.trackID {
		return errors.New("system media track is no longer active")
	}
	playback, position, err := mediaPlayback(state, positionMS, s.duration)
	if err != nil {
		return err
	}
	s.media.SetPlayback(playback, position)
	return nil
}

func (s *systemMediaState) clear(ctx context.Context, generation, revision uint64) error {
	if !s.owns(ctx, generation) || revision == 0 || revision <= s.revision {
		return errors.New("system media snapshot is no longer active")
	}
	s.revision = revision
	s.clearMedia()
	return nil
}

func (s *systemMediaState) teardown(ctx context.Context, generation uint64) error {
	if s.owner == nil && s.releasedOwner == ctx && s.releasedGeneration == generation {
		return nil
	}
	if !s.owns(ctx, generation) {
		return errors.New("system media owner or generation is no longer active")
	}
	s.revoke()
	return nil
}
