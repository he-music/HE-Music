package main

import (
	"errors"
	"unicode"
	"unicode/utf8"
)

type TrayPlayMode string

const (
	TrayModeRepeat     TrayPlayMode = "repeat"
	TrayModeRepeatOnce TrayPlayMode = "repeat-once"
	TrayModeShuffle    TrayPlayMode = "shuffle"
	trayMaxSafeInteger uint64       = 9007199254740991
)

type TrayRequest struct {
	Epoch    uint64        `json:"epoch"`
	Revision uint64        `json:"revision"`
	TrackKey string        `json:"trackKey"`
	Action   TrayAction    `json:"action"`
	Favorite *bool         `json:"favorite,omitempty"`
	Mode     *TrayPlayMode `json:"mode,omitempty"`
}

// traySession is confined to the main thread. Readiness and Page ownership are
// checked by the caller; this policy never consults native resources.
type traySession struct {
	counter uint64
	state   TrayPlaybackState
}

func (s *traySession) begin() (uint64, error) {
	s.revoke()
	if s.counter >= trayMaxSafeInteger {
		return 0, errors.New("tray epoch exhausted")
	}
	s.counter++
	s.state = TrayPlaybackState{Epoch: s.counter, PlayMode: TrayModeRepeat}
	return s.counter, nil
}

func (s *traySession) revoke() { s.state = TrayPlaybackState{} }

func validTrayNumber(value uint64) bool { return value > 0 && value <= trayMaxSafeInteger }

func validTrayMode(mode TrayPlayMode) bool {
	return mode == TrayModeRepeat || mode == TrayModeRepeatOnce || mode == TrayModeShuffle
}

func (s *traySession) sync(next TrayPlaybackState) error {
	if !validTrayNumber(next.Epoch) || next.Epoch != s.state.Epoch ||
		!validTrayNumber(next.Revision) || next.Revision <= s.state.Revision {
		return errors.New("stale or invalid tray identity")
	}
	if !validTrayMode(next.PlayMode) {
		return errors.New("invalid tray play mode")
	}
	if len(next.TrackKey) > 512 || !utf8.ValidString(next.TrackKey) {
		return errors.New("invalid tray track key")
	}
	for _, r := range next.TrackKey {
		if unicode.IsControl(r) {
			return errors.New("invalid tray track key")
		}
	}
	if next.HasSong != (next.TrackKey != "") ||
		(!next.HasSong && (next.Playing || next.Liked || next.CanFavorite || next.CanSetMode)) {
		return errors.New("inconsistent tray song state")
	}
	s.state = next
	return nil
}

func (s *traySession) snapshot() TrayPlaybackState { return s.state }

// Compare the complete captured value: never stamp a stale callback with the
// identity of the current song, including an A -> B -> A transition.
func (s *traySession) matches(captured TrayPlaybackState) bool {
	return validTrayNumber(s.state.Epoch) && captured == s.state
}

func (s *traySession) request(captured TrayPlaybackState, action TrayAction, mode *TrayPlayMode) (TrayRequest, error) {
	request := TrayRequest{
		Epoch: captured.Epoch, Revision: captured.Revision, TrackKey: captured.TrackKey,
		Action: action, Mode: mode,
	}
	if action == TrayFavorite {
		desired := !captured.Liked
		request.Favorite = &desired
	}
	if err := s.validateRequest(captured, request); err != nil {
		return TrayRequest{}, err
	}
	// Own the optional value rather than retaining a caller-mutable pointer.
	if mode != nil {
		target := *mode
		request.Mode = &target
	}
	return request, nil
}

func (s *traySession) validateRequest(captured TrayPlaybackState, request TrayRequest) error {
	if !s.matches(captured) || request.Epoch != captured.Epoch ||
		request.Revision != captured.Revision || request.TrackKey != captured.TrackKey {
		return errors.New("stale tray request")
	}
	if request.Action == TrayOpenSettings {
		if request.Favorite != nil || request.Mode != nil {
			return errors.New("unexpected tray parameters")
		}
		return nil
	}
	if !validTrayNumber(captured.Revision) || !captured.HasSong {
		return errors.New("tray song unavailable")
	}
	switch request.Action {
	case TrayPrevious, TrayToggle, TrayNext:
		if request.Favorite != nil || request.Mode != nil {
			return errors.New("unexpected tray parameters")
		}
	case TrayFavorite:
		if !captured.CanFavorite || request.Mode != nil || request.Favorite == nil || *request.Favorite == captured.Liked {
			return errors.New("invalid tray favorite request")
		}
	case TraySetPlayMode:
		if !captured.CanSetMode || request.Favorite != nil || request.Mode == nil || !validTrayMode(*request.Mode) {
			return errors.New("invalid tray mode request")
		}
	default:
		return errors.New("unknown tray action")
	}
	return nil
}
