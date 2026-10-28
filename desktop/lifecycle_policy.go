package main

import "context"

type CloseAppMethod string

const (
	CloseAppExit CloseAppMethod = "exit"
	CloseAppHide CloseAppMethod = "hide"
)

type TrayAction string

const (
	TrayPrevious     TrayAction = "previous"
	TrayToggle       TrayAction = "toggle"
	TrayNext         TrayAction = "next"
	TrayOpenSettings TrayAction = "open-settings"
)

type CloseResolution string

const (
	CloseCancel CloseResolution = "cancel"
	CloseHide   CloseResolution = "hide"
	CloseExit   CloseResolution = "exit"
)

type LifecycleLabels struct {
	Show         string `json:"show"`
	Hide         string `json:"hide,omitempty"`
	Play         string `json:"play"`
	Pause        string `json:"pause"`
	Previous     string `json:"previous"`
	Next         string `json:"next"`
	ShowLyrics   string `json:"showLyrics,omitempty"`
	HideLyrics   string `json:"hideLyrics,omitempty"`
	LockLyrics   string `json:"lockLyrics,omitempty"`
	UnlockLyrics string `json:"unlockLyrics,omitempty"`
	Settings     string `json:"settings,omitempty"`
	Quit         string `json:"quit"`
}

type LifecycleConfig struct {
	ShowCloseAppTip bool            `json:"showCloseAppTip"`
	CloseAppMethod  CloseAppMethod  `json:"closeAppMethod"`
	Labels          LifecycleLabels `json:"labels"`
}

type LifecycleStatus struct {
	TrayAvailable bool `json:"trayAvailable"`
}

type TrayPlaybackState struct {
	Playing bool `json:"playing"`
	HasSong bool `json:"hasSong"`
}

type CloseRequested struct {
	RequestID uint64 `json:"requestId"`
}

type closeDecision uint8

const (
	closeAllow closeDecision = iota
	closeHide
	closePrompt
)

// All policy and native lifecycle state is confined to mygo's main thread.
// A page context survives bound calls but is canceled on navigation/destruction.
// No mutex may be held while calling a native API (which can reenter callbacks).
type lifecycleState struct {
	owner        context.Context
	config       LifecycleConfig
	tray         bool
	quitting     bool
	cleaned      bool
	nextRequest  uint64
	pending      uint64
	acknowledged bool
}

func (s *lifecycleState) ready() bool {
	return s.owner != nil && s.owner.Err() == nil && !s.quitting && !s.cleaned
}

func (s *lifecycleState) owns(ctx context.Context) bool {
	return s.ready() && ctx == s.owner
}

func (s *lifecycleState) closeDecision() closeDecision {
	if !s.ready() || !s.tray {
		return closeAllow
	}
	if s.config.ShowCloseAppTip {
		return closePrompt
	}
	if s.config.CloseAppMethod == CloseAppHide {
		return closeHide
	}
	return closeAllow
}

func (s *lifecycleState) invalidate() {
	s.owner = nil
	s.pending = 0
	s.acknowledged = false
}

func (s *lifecycleState) beginQuit() {
	s.quitting = true
	s.invalidate()
}

func (s *lifecycleState) cleanup() bool {
	if s.cleaned {
		return false
	}
	s.cleaned = true
	s.tray = false
	s.beginQuit()
	return true
}
