// Package media is the contract between ui's VideoPlayer and the engines
// that play video with the system's media frameworks (package ui/video):
// AVFoundation on macOS, Media Foundation on Windows, GStreamer on Linux
// and the video element in browsers. An engine decodes, plays the sound
// and keeps the clock; the player asks it, as each frame of the window
// builds, which picture is due, and shows it where the engine left it
// (scene.Surface), without a copy.
package media

import (
	"time"

	"github.com/egoist/mygo/internal/scene"
)

// An Engine plays one video. Its methods are called on the main thread,
// one at a time, except Close, which may be called from any goroutine
// once nothing else is.
type Engine interface {
	// SetWake gives the function the engine calls, from any goroutine,
	// when the window showing the video should build a frame: the first
	// picture came, the state changed, a seek landed. A change Frame
	// itself makes, as Loading to Ready by the first picture, needs none:
	// the player reads the state again after it. It may be called
	// before the engine is ready and again later; a nil func stops it.
	SetWake(wake func())
	// Frame returns the picture due at t, a time of the monotonic clock
	// at which the frame being built shows, and whether it is another
	// picture than the last Frame returned; ok is false while there is
	// none yet. The picture stays valid until Frame returns another, or
	// the engine closes.
	Frame(t time.Time) (f Picture, changed, ok bool)
	// Interval is how long a picture shows at the video's nominal rate at
	// rate 1, for the window to ask for its next frame as each comes due;
	// 0 for an engine that wakes the window as each picture comes due.
	Interval() time.Duration
	// State reports how loading and playing go, and the error that
	// stopped the video, if any.
	State() (State, error)
	// Size is the size of the pictures in pixels, 0×0 until known.
	Size() (w, h int)
	Duration() time.Duration // 0 until known, or for a live stream
	Position() time.Duration
	Play()
	Pause()
	Seek(time.Duration)
	SetLoop(bool)
	SetRate(float64)
	SetVolume(float64)
	SetMuted(bool)
	Close() error
}

// A Picture is a frame of video where the engine left it.
type Picture struct {
	Surface *scene.Surface
	W, H    int
	// RGBA converts it to premultiplied RGBA, for the CPU renderer and
	// captures, into dst when it has room.
	RGBA func(dst []byte) []byte
}

// State is the state of an engine.
type State uint8

const (
	// Loading is before the video's first picture and size are known.
	Loading State = iota
	// Ready is playing or paused with pictures to show.
	Ready
	// Buffering waits for data that a stream is still downloading.
	Buffering
	// Ended is past the end of a video that does not loop.
	Ended
	// Failed is a video that stopped with an error.
	Failed
)
