package main

import (
	"context"
	"errors"
	"math"
)

var (
	errLyricsOwner = errors.New("desktop lyrics owner unavailable")
	errLyricsEpoch = errors.New("desktop lyrics epoch is stale")
	errLyricsData  = errors.New("desktop lyrics data is invalid or stale")
)

const lyricsMaxSequence uint64 = 1<<53 - 1

// Confined to the main thread by DesktopLyrics. Generation never resets, even
// when an epoch ends, because native callbacks can outlive their window.
type lyricsState struct {
	owner      context.Context
	epoch      uint64
	generation uint64
	window     LyricsWindowState
	ready      bool
	attached   bool
	snapshot   *LyricsSnapshot
	seq        uint64
}

func (s *lyricsState) begin(owner context.Context) (LyricsSession, error) {
	if owner == nil || owner.Err() != nil || s.epoch == lyricsMaxSequence {
		return LyricsSession{}, errLyricsOwner
	}
	s.owner = owner
	s.epoch++
	s.seq, s.snapshot = 0, nil
	s.window = LyricsWindowState{Epoch: s.epoch, Revision: 1, Bounds: LyricsBounds{Width: 800, Height: 180}}
	return LyricsSession{Epoch: s.epoch}, nil
}

func (s *lyricsState) authorize(ctx context.Context, epoch uint64, main, child, childAllowed bool) error {
	if s.owner == nil || s.owner.Err() != nil || ctx.Err() != nil ||
		(!(main && ctx == s.owner) && !(childAllowed && child)) {
		return errLyricsOwner
	}
	if epoch != s.epoch || epoch == 0 {
		return errLyricsEpoch
	}
	return nil
}

func (s *lyricsState) open() uint64 {
	s.generation++
	s.ready, s.attached = false, false
	s.window.Visible, s.window.Pending, s.window.Failure = false, true, ""
	s.window.Locked, s.window.HoverUnlock = false, false
	s.window.Revision++
	return s.generation
}

func (s *lyricsState) current(generation uint64) bool {
	return s.owner != nil && s.owner.Err() == nil && generation == s.generation &&
		(s.window.Pending || s.window.Visible)
}

func (s *lyricsState) showable(generation uint64) bool {
	return s.current(generation) && s.ready && s.attached && s.window.Pending
}

func (s *lyricsState) shown() {
	s.window.Visible, s.window.Pending = true, false
	s.window.Revision++
}

func (s *lyricsState) setLocked(locked, externalUnlock bool) error {
	if s.window.Locked == locked {
		return nil
	}
	if locked && (!s.current(s.generation) || !s.window.Visible || s.window.Pending || !externalUnlock) {
		return errors.New("locking desktop lyrics requires a visible window and native unlock menu")
	}
	s.window.Locked, s.window.HoverUnlock = locked, false
	s.window.Revision++
	return nil
}

func (s *lyricsState) close(generation uint64, failure string) bool {
	if generation != s.generation || (!s.window.Pending && !s.window.Visible) {
		return false
	}
	s.generation++
	s.ready, s.attached = false, false
	s.window.Visible, s.window.Pending, s.window.Failure = false, false, failure
	s.window.Locked, s.window.HoverUnlock = false, false
	s.window.Revision++
	return true
}

func (s *lyricsState) revoke() {
	s.owner, s.snapshot = nil, nil
	s.seq = 0
	s.ready, s.attached = false, false
	s.window.Locked, s.window.HoverUnlock = false, false
}

func validLyricsTime(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= float64(lyricsMaxSequence)
}

func validateLyricsClock(clock LyricsClock) bool {
	return clock.Seq > 0 && clock.Seq <= lyricsMaxSequence && validLyricsTime(clock.PositionMs) &&
		clock.PositionMs >= 0 && validLyricsTime(clock.OffsetMs) && validLyricsTime(clock.Rate) &&
		clock.Rate > 0 && clock.Rate <= 16
}

func validLyricsLines(lines []LyricsLine) bool {
	for _, line := range lines {
		if !validLyricsTime(line.StartTime) || !validLyricsTime(line.EndTime) ||
			line.StartTime < 0 || line.EndTime < line.StartTime {
			return false
		}
		for _, word := range line.Words {
			if !validLyricsTime(word.StartTime) || !validLyricsTime(word.EndTime) ||
				word.StartTime < 0 || word.EndTime < word.StartTime {
				return false
			}
		}
	}
	return true
}

func (s *lyricsState) publishSnapshot(snapshot LyricsSnapshot) error {
	clock := LyricsClock{Epoch: snapshot.Epoch, Seq: snapshot.Seq, TrackKey: snapshot.TrackKey,
		Playing: snapshot.Playing, PositionMs: snapshot.PositionMs, OffsetMs: snapshot.OffsetMs, Rate: snapshot.Rate}
	if snapshot.Epoch != s.epoch || snapshot.Seq <= s.seq || !validateLyricsClock(clock) ||
		!validLyricsLines(snapshot.LrcData) || !validLyricsLines(snapshot.YrcData) {
		return errLyricsData
	}
	if snapshot.Style != nil && !validLyricsStyle(*snapshot.Style) {
		return errLyricsData
	}
	// Bound arguments are decoded per call; copy arrays as well so policy callers
	// cannot mutate cached lyrics after validation.
	snapshot.LrcData = cloneLyricsLines(snapshot.LrcData)
	snapshot.YrcData = cloneLyricsLines(snapshot.YrcData)
	snapshot.Style = cloneLyricsStyle(snapshot.Style)
	s.snapshot, s.seq = &snapshot, snapshot.Seq
	return nil
}

func cloneLyricsLines(lines []LyricsLine) []LyricsLine {
	out := make([]LyricsLine, len(lines))
	for i, line := range lines {
		out[i] = line
		out[i].Words = make([]LyricsWord, len(line.Words))
		copy(out[i].Words, line.Words)
		for j, word := range line.Words {
			if word.RomanWord != nil {
				roman := *word.RomanWord
				out[i].Words[j].RomanWord = &roman
			}
		}
	}
	return out
}

func (s *lyricsState) publishClock(clock LyricsClock) error {
	if s.snapshot == nil || clock.Epoch != s.epoch || clock.Seq <= s.seq ||
		clock.TrackKey != s.snapshot.TrackKey || !validateLyricsClock(clock) {
		return errLyricsData
	}
	s.seq = clock.Seq
	s.snapshot.Seq, s.snapshot.Playing = clock.Seq, clock.Playing
	s.snapshot.PositionMs, s.snapshot.OffsetMs, s.snapshot.Rate = clock.PositionMs, clock.OffsetMs, clock.Rate
	return nil
}

func (s *lyricsState) attachment() LyricsAttachment {
	result := LyricsAttachment{Window: s.window}
	if s.snapshot != nil {
		snapshot := *s.snapshot
		snapshot.LrcData = cloneLyricsLines(snapshot.LrcData)
		snapshot.YrcData = cloneLyricsLines(snapshot.YrcData)
		snapshot.Style = cloneLyricsStyle(snapshot.Style)
		result.Snapshot = &snapshot
	}
	return result
}

func (s *lyricsState) validateCommand(command LyricsCommand) error {
	if command.Epoch != s.epoch {
		return errLyricsEpoch
	}
	switch command.Action {
	case LyricsPrevious, LyricsToggle, LyricsNext:
		if s.snapshot == nil || command.TrackKey == "" || command.TrackKey != s.snapshot.TrackKey {
			return errLyricsData
		}
	case LyricsShowMain, LyricsOpenSettings:
	default:
		return errLyricsData
	}
	return nil
}

func validateLyricsBounds(bounds LyricsBounds) error {
	if bounds.Width < 640 || bounds.Width > 1400 || bounds.Height < 140 || bounds.Height > 360 ||
		bounds.X < -10000000 || bounds.X > 10000000 || bounds.Y < -10000000 || bounds.Y > 10000000 {
		return errors.New("desktop lyrics bounds are invalid")
	}
	return nil
}

// Pick one real work area, never the rectangle enclosing multiple displays.
// Tiny displays retain the minimum window size with its top-left reachable.
func fitLyricsBounds(bounds LyricsBounds, areas []LyricsBounds) (LyricsBounds, error) {
	if err := validateLyricsBounds(bounds); err != nil {
		return LyricsBounds{}, err
	}
	best, distance := LyricsBounds{}, math.Inf(1)
	for _, area := range areas {
		if area.Width <= 0 || area.Height <= 0 {
			continue
		}
		candidate := bounds
		candidate.Width = max(640, min(bounds.Width, area.Width))
		candidate.Height = max(140, min(bounds.Height, area.Height))
		candidate.X = max(area.X, min(bounds.X, area.X+max(0, area.Width-candidate.Width)))
		candidate.Y = max(area.Y, min(bounds.Y, area.Y+max(0, area.Height-candidate.Height)))
		dx, dy := float64(candidate.X-bounds.X), float64(candidate.Y-bounds.Y)
		if d := dx*dx + dy*dy; d < distance {
			best, distance = candidate, d
		}
	}
	if math.IsInf(distance, 1) {
		return LyricsBounds{}, errors.New("desktop lyrics has no usable display")
	}
	return best, nil
}
