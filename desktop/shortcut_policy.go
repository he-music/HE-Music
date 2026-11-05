package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type ShortcutAction string

const (
	ShortcutPlayOrPause        ShortcutAction = "playOrPause"
	ShortcutPlayPrev           ShortcutAction = "playPrev"
	ShortcutPlayNext           ShortcutAction = "playNext"
	ShortcutVolumeUp           ShortcutAction = "volumeUp"
	ShortcutVolumeDown         ShortcutAction = "volumeDown"
	ShortcutToggleDesktopLyric ShortcutAction = "toggleDesktopLyric"
)

type ShortcutBinding struct {
	Action      ShortcutAction `json:"action"`
	Accelerator string         `json:"accelerator"`
}

type ShortcutResult struct {
	Action      ShortcutAction `json:"action"`
	Accelerator string         `json:"accelerator"`
	Normalized  string         `json:"normalized"`
	Status      string         `json:"status"`
	Error       string         `json:"error"`
}

type ShortcutStatus struct {
	Generation uint64           `json:"generation"`
	Enabled    bool             `json:"enabled"`
	Suspended  bool             `json:"suspended"`
	Results    []ShortcutResult `json:"results"`
}

type ShortcutEvent struct {
	Generation uint64         `json:"generation"`
	Action     ShortcutAction `json:"action"`
}

type ShortcutCheck struct {
	Normalized        string `json:"normalized"`
	RegisteredByOwner bool   `json:"registeredByOwner"`
	Error             string `json:"error"`
}

type shortcutBackend interface {
	Register(string, func()) error
	Unregister(string)
}

// State and backend calls are confined to the mygo main thread. Tests use a fake
// backend: construction, binding generation and policy tests never touch native APIs.
type shortcutState struct {
	owner      context.Context
	generation uint64
	enabled    bool
	suspended  bool
	bindings   []ShortcutBinding
	owned      map[string]ShortcutAction
	backend    shortcutBackend
	goos       string
	valid      func(context.Context) bool
	emit       func(ShortcutEvent)
}

func supportedShortcutAction(action ShortcutAction) bool {
	switch action {
	case ShortcutPlayOrPause, ShortcutPlayPrev, ShortcutPlayNext, ShortcutVolumeUp, ShortcutVolumeDown, ShortcutToggleDesktopLyric:
		return true
	}
	return false
}

// normalizeShortcut deliberately accepts the existing recorder's portable subset,
// rather than promising every menu accelerator is supported by global hotkeys.
func normalizeShortcut(input, goos string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("empty accelerator")
	}
	parts := strings.Split(input, "+")
	mods := map[string]bool{}
	for _, part := range parts[:len(parts)-1] {
		modifier, err := shortcutModifier(part, goos)
		if err != nil {
			return "", err
		}
		mods[modifier] = true
	}
	key, err := normalizeShortcutKey(parts[len(parts)-1], goos)
	if err != nil {
		return "", err
	}
	canonical := []string{}
	for _, modifier := range []string{"Super", "Ctrl", "Alt", "Shift"} {
		if mods[modifier] {
			canonical = append(canonical, modifier)
		}
	}
	return strings.Join(append(canonical, key), "+"), nil
}

func shortcutModifier(part, goos string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(part)) {
	case "cmdorctrl", "commandorcontrol":
		if goos == "darwin" {
			return "Super", nil
		}
		return "Ctrl", nil
	case "cmd", "command", "super", "meta", "win":
		return "Super", nil
	case "ctrl", "control":
		return "Ctrl", nil
	case "alt", "option":
		return "Alt", nil
	case "shift":
		return "Shift", nil
	default:
		return "", errors.New("invalid modifier")
	}
}

func shortcutKeyToken(input string) string {
	key := strings.ToLower(strings.TrimSpace(input))
	if len(key) == 4 && strings.HasPrefix(key, "key") && key[3] >= 'a' && key[3] <= 'z' {
		return key[3:]
	}
	if len(key) == 6 && strings.HasPrefix(key, "digit") && key[5] >= '0' && key[5] <= '9' {
		return key[5:]
	}
	return key
}

func normalizeShortcutKey(input, goos string) (string, error) {
	key := shortcutKeyToken(input)
	if len(key) == 1 && ((key[0] >= 'a' && key[0] <= 'z') || (key[0] >= '0' && key[0] <= '9')) {
		return strings.ToUpper(key), nil
	}
	if named := map[string]string{
		"space": "Space", "left": "Left", "arrowleft": "Left", "right": "Right", "arrowright": "Right",
		"up": "Up", "arrowup": "Up", "down": "Down", "arrowdown": "Down", "escape": "Escape", "esc": "Escape",
	}[key]; named != "" {
		return named, nil
	}
	if !strings.HasPrefix(key, "f") {
		return "", errors.New("unsupported key")
	}
	n, err := strconv.Atoi(key[1:])
	if err != nil || n < 1 || n > 24 || strconv.Itoa(n) != key[1:] {
		return "", errors.New("unsupported key")
	}
	if goos == "darwin" && n > 20 {
		return "", errors.New("F21-F24 are unsupported by the macOS global shortcut backend")
	}
	return fmt.Sprintf("F%d", n), nil
}

func (s *shortcutState) owns(ctx context.Context, generation uint64) bool {
	return s.owner != nil && s.owner == ctx && ctx.Err() == nil && s.generation == generation && s.valid(ctx)
}

func (s *shortcutState) release() {
	// Invalidate callbacks before unregistering; a backend may reenter while unbinding.
	s.generation++
	owned := s.owned
	s.owned = nil
	for accelerator := range owned {
		s.backend.Unregister(accelerator)
	}
}

func (s *shortcutState) revoke() {
	if s.owner == nil && len(s.owned) == 0 {
		return
	}
	s.owner = nil
	s.release()
	s.bindings = nil
	s.enabled = false
	s.suspended = false
}

func (s *shortcutState) replace(ctx context.Context, generation uint64, enabled bool, bindings []ShortcutBinding) (ShortcutStatus, error) {
	if ctx.Err() != nil || !s.valid(ctx) || (s.owner == nil && generation != 0) ||
		(s.owner != nil && !s.owns(ctx, generation)) {
		return ShortcutStatus{}, errors.New("shortcut owner or generation is no longer active")
	}
	s.release()
	s.owner = ctx
	s.enabled = enabled
	s.suspended = false
	s.bindings = append([]ShortcutBinding(nil), bindings...)
	return s.apply(), nil
}

func (s *shortcutState) setSuspended(ctx context.Context, generation uint64, suspended bool) (ShortcutStatus, error) {
	if !s.owns(ctx, generation) {
		return ShortcutStatus{}, errors.New("shortcut owner or generation is no longer active")
	}
	s.release()
	s.suspended = suspended
	return s.apply(), nil
}

func (s *shortcutState) apply() ShortcutStatus {
	status := ShortcutStatus{Generation: s.generation, Enabled: s.enabled, Suspended: s.suspended, Results: []ShortcutResult{}}
	actions, combinations := map[ShortcutAction]bool{}, map[string]bool{}
	for _, binding := range s.bindings {
		result := ShortcutResult{Action: binding.Action, Accelerator: binding.Accelerator}
		switch {
		case !supportedShortcutAction(binding.Action):
			result.Status, result.Error = "unsupported", "action has no global shortcut implementation"
		case actions[binding.Action]:
			result.Status, result.Error = "duplicate-action", "first occurrence of action wins"
		default:
			actions[binding.Action] = true
			if strings.TrimSpace(binding.Accelerator) == "" {
				result.Status = "empty"
			} else if normalized, err := normalizeShortcut(binding.Accelerator, s.goos); err != nil {
				result.Status, result.Error = "invalid", err.Error()
			} else {
				result.Normalized = normalized
				switch {
				case combinations[normalized]:
					result.Status, result.Error = "duplicate-accelerator", "first valid occurrence of accelerator wins"
				default:
					combinations[normalized] = true
					result.Status = "disabled"
					if s.enabled && !s.suspended {
						result.Status = "registered"
						owner, generation, action := s.owner, s.generation, binding.Action
						if err := s.backend.Register(normalized, func() {
							if s.owns(owner, generation) && s.owned[normalized] == action {
								s.emit(ShortcutEvent{Generation: generation, Action: action})
							}
						}); err != nil {
							result.Status, result.Error = "registration-failed", err.Error()
						} else {
							if s.owned == nil {
								s.owned = map[string]ShortcutAction{}
							}
							s.owned[normalized] = action
						}
					}
				}
			}
		}
		status.Results = append(status.Results, result)
	}
	return status
}

func (s *shortcutState) check(input string) ShortcutCheck {
	normalized, err := normalizeShortcut(input, s.goos)
	if err != nil {
		return ShortcutCheck{Error: err.Error()}
	}
	_, registered := s.owned[normalized]
	return ShortcutCheck{Normalized: normalized, RegisteredByOwner: registered}
}
