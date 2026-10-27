package main

import (
	"context"
	"os"

	"github.com/egoist/mygo"
)

var (
	desktopSystemMediaCommand = mygo.NewEvent[SystemMediaCommand]("desktop:system-media-command")
	desktopSystemMedia        = &SystemMedia{}
)

// SystemMedia is optional and acquires nothing until a Ready main-page owner
// explicitly configures it. Binding generation only describes the contract.
type SystemMedia struct{ state systemMediaState }

func init() {
	desktopSystemMedia.state = systemMediaState{
		media: mygo.NowPlaying,
		power: mygo.Power,
		valid: func(ctx context.Context) bool {
			l := desktopLifecycle
			return os.Getenv("MYGO_GENERATE") == "" && l.main != nil && !l.main.IsDestroyed() &&
				l.state.owns(ctx) && sameLifecyclePage(l.main.Page(), mygo.CallerPage(ctx))
		},
		emit: func(event SystemMediaCommand) {
			if err := desktopSystemMediaCommand.EmitPage(desktopLifecycle.main.Page(), event); err != nil {
				desktopSystemMedia.revoke()
			}
		},
	}
	mygo.Bind(desktopSystemMedia)
}

// Configure claims with generation=0, then requires the last returned generation.
// Serialize shell mutations. Subscribe before configuring; discard queued events
// unless generation, revision and trackId all match the frontend's current song.
func (s *SystemMedia) Configure(ctx context.Context, generation uint64, mediaEnabled, preventSleep bool) (SystemMediaStatus, error) {
	var status SystemMediaStatus
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		status, err = s.state.configure(ctx, generation, mediaEnabled, preventSleep)
		return err
	})
	return status, err
}

// Set consumes an increasing revision even for unsupported/invalid metadata.
// Revisions must be allocated before any asynchronous preparation. Artwork uses
// the separately targeted SetArtwork API; URLs and filesystem paths are never accepted.
func (s *SystemMedia) Set(ctx context.Context, generation, revision uint64, track SystemMediaTrack) error {
	return desktopLifecycle.call(ctx, true, func() error { return s.state.set(ctx, generation, revision, track) })
}

// SetPlayback is for actual play/pause/stop or jumps, never each progress tick.
// The system advances position while playing; report HTMLAudio's accepted state.
func (s *SystemMedia) SetPlayback(ctx context.Context, generation, revision uint64, trackID, state string, positionMS float64) error {
	return desktopLifecycle.call(ctx, true, func() error { return s.state.playback(ctx, generation, revision, trackID, state, positionMS) })
}

func (s *SystemMedia) Clear(ctx context.Context, generation, revision uint64) error {
	return desktopLifecycle.call(ctx, true, func() error { return s.state.clear(ctx, generation, revision) })
}

func (s *SystemMedia) Teardown(ctx context.Context, generation uint64) error {
	return desktopLifecycle.call(ctx, true, func() error { return s.state.teardown(ctx, generation) })
}

func (s *SystemMedia) revoke() { s.state.revoke() }
