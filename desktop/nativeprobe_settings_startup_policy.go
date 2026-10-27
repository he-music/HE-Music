//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"encoding/json"
	"errors"
	"regexp"
)

// These DTOs are the persistence whitelist. Eval values are never written raw.
type startupNodeStyle struct {
	Exists             bool      `json:"exists"`
	ID                 int       `json:"id,omitempty"`
	Connected          bool      `json:"connected,omitempty"`
	Rect               []float64 `json:"rect,omitempty"`
	Phases             []string  `json:"phases,omitempty"`
	Display            string    `json:"display,omitempty"`
	Visibility         string    `json:"visibility,omitempty"`
	Opacity            string    `json:"opacity,omitempty"`
	Transform          string    `json:"transform,omitempty"`
	TransitionDuration string    `json:"transitionDuration,omitempty"`
	TransitionDelay    string    `json:"transitionDelay,omitempty"`
	AnimationDuration  string    `json:"animationDuration,omitempty"`
	AnimationDelay     string    `json:"animationDelay,omitempty"`
}
type startupNode struct {
	Kind      string           `json:"kind"`
	Container startupNodeStyle `json:"container"`
	Mask      startupNodeStyle `json:"mask"`
	Wrapper   startupNodeStyle `json:"wrapper"`
	Inner     startupNodeStyle `json:"inner"`
}
type startupSnapshotDTO struct {
	DocumentID        string        `json:"documentId"`
	SameDocument      bool          `json:"sameDocument"`
	Revision          int           `json:"revision"`
	Errors            int           `json:"errors"`
	Rejections        int           `json:"rejections"`
	UnknownErrors     int           `json:"unknownErrors"`
	Unsafe            bool          `json:"unsafe"`
	Empty             bool          `json:"empty"`
	Modals            int           `json:"modals"`
	Unknown           int           `json:"unknown"`
	Drawers           int           `json:"drawers"`
	Settings          int           `json:"settings"`
	Active            bool          `json:"active"`
	RafCount          int           `json:"rafCount"`
	TimerCount        int           `json:"timerCount"`
	VueFlushCompleted bool          `json:"vueFlushCompleted"`
	Visibility        string        `json:"visibility"`
	Hidden            bool          `json:"hidden"`
	HasFocus          bool          `json:"hasFocus"`
	APIID             string        `json:"apiId"`
	Nodes             []startupNode `json:"nodes"`
}
type startupObservationDTO struct {
	InitialPreparationPassed bool                 `json:"initialPreparationPassed"`
	FinalSurfaceSafe         bool                 `json:"finalSurfaceSafe"`
	PreparationError         string               `json:"preparationError"`
	UnknownFailures          int                  `json:"unknownFailures"`
	UnsafeSurfaceObserved    bool                 `json:"unsafeSurfaceObserved"`
	Current                  startupSnapshotDTO   `json:"current"`
	Snapshots                []startupSnapshotDTO `json:"snapshots"`
	Events                   struct {
		Run          int `json:"run"`
		End          int `json:"end"`
		Cancel       int `json:"cancel"`
		AnimationEnd int `json:"animationEnd"`
	} `json:"events"`
}
type startupLoadSnapshot struct {
	Blank      uint64 `json:"blank"`
	Controlled uint64 `json:"controlled"`
	Other      uint64 `json:"other"`
}
type startupSample struct {
	Observation startupObservationDTO `json:"observation"`
	LoadsBefore startupLoadSnapshot   `json:"loadsBefore"`
	LoadsAfter  startupLoadSnapshot   `json:"loadsAfter"`
}
type startupFailure struct {
	Stage    string `json:"stage"`
	Category string `json:"category"`
	Count    int    `json:"count"`
}

var startupDocumentID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func requiredStartupFields(raw map[string]json.RawMessage, fields ...string) bool {
	for _, field := range fields {
		value, ok := raw[field]
		if !ok || string(value) == "null" {
			return false
		}
	}
	return true
}

func decodeStartupObservation(value any) (startupObservationDTO, error) {
	var observation startupObservationDTO
	encoded, err := json.Marshal(value)
	if err != nil {
		return observation, errors.New("invalid-observation")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(encoded, &raw) != nil || !requiredStartupFields(raw,
		"initialPreparationPassed", "finalSurfaceSafe", "preparationError", "unknownFailures", "unsafeSurfaceObserved", "current", "snapshots", "events") {
		return observation, errors.New("missing-observation-fields")
	}
	var current map[string]json.RawMessage
	if json.Unmarshal(raw["current"], &current) != nil || !requiredStartupFields(current,
		"documentId", "sameDocument", "revision", "errors", "rejections", "unknownErrors",
		"unsafe", "empty", "modals", "unknown", "drawers", "settings", "active",
		"rafCount", "timerCount", "vueFlushCompleted", "visibility", "hidden", "hasFocus", "apiId", "nodes") {
		return observation, errors.New("missing-snapshot-fields")
	}
	var history []map[string]json.RawMessage
	if json.Unmarshal(raw["snapshots"], &history) != nil {
		return observation, errors.New("invalid-history")
	}
	for _, snapshot := range history {
		for field := range current {
			if !requiredStartupFields(snapshot, field) {
				return observation, errors.New("missing-history-fields")
			}
		}
	}
	var events map[string]json.RawMessage
	if json.Unmarshal(raw["events"], &events) != nil || !requiredStartupFields(events, "run", "end", "cancel", "animationEnd") {
		return observation, errors.New("missing-event-fields")
	}
	if json.Unmarshal(encoded, &observation) != nil {
		return observation, errors.New("invalid-observation-types")
	}
	s := observation.Current
	if !startupDocumentID.MatchString(s.DocumentID) || s.Revision < 0 || s.Errors < 0 || s.Rejections < 0 || s.UnknownErrors < 0 || observation.UnknownFailures < 0 ||
		s.Modals < 0 || s.Unknown < 0 || s.Drawers < 0 || s.Settings < 0 || s.RafCount < 0 || s.RafCount > 4 || s.TimerCount < 0 || s.TimerCount > 60 ||
		len(s.Nodes) > 4 || len(observation.Snapshots) > 24 {
		return startupObservationDTO{}, errors.New("invalid-observation-values")
	}
	switch observation.PreparationError {
	case "unavailable", "startup-gate-rejected", "observation-failed":
	default:
		return startupObservationDTO{}, errors.New("invalid-observation-guard")
	}
	all := append([]startupSnapshotDTO{observation.Current}, observation.Snapshots...)
	for _, snapshot := range all {
		if !validStartupSnapshot(snapshot) {
			return startupObservationDTO{}, errors.New("invalid-snapshot-whitelist")
		}
	}
	// Re-encode only bounded, typed public diagnostics; never arbitrary JS fields.
	return observation, nil
}

// The cap limits stored snapshots, never the observed-unsafe latch.
func startupObservedUnsafe(o startupObservationDTO) bool {
	unsafe := func(s startupSnapshotDTO) bool {
		return s.Unsafe || s.Unknown > 0 || s.Drawers > 0 || s.Settings > 0
	}
	if o.UnsafeSurfaceObserved || unsafe(o.Current) {
		return true
	}
	for _, snapshot := range o.Snapshots {
		if unsafe(snapshot) {
			return true
		}
	}
	return false
}

func startupSurfaceSafe(o startupObservationDTO) bool {
	s := o.Current
	return !startupObservedUnsafe(o) && s.SameDocument && s.Empty && !s.Unsafe && s.Modals == 0 && s.Unknown == 0 && s.Drawers == 0 && s.Settings == 0 &&
		s.Errors == 0 && s.Rejections == 0 && s.UnknownErrors == 0 && o.UnknownFailures == 0
}

func evaluateStartupSamples(samples []startupSample) (bool, []string) {
	reasons := []string{}
	if len(samples) < 2 {
		return false, []string{"missing-final-observation"}
	}
	first := samples[0]
	if first.LoadsBefore.Controlled == 0 || first.LoadsBefore.Other != 0 {
		reasons = append(reasons, "invalid-initial-load")
	}
	for _, sample := range samples {
		o := sample.Observation
		if !o.InitialPreparationPassed {
			reasons = append(reasons, "initial-preparation-failed")
			break
		}
	}
	for _, sample := range samples {
		if sample.LoadsBefore != first.LoadsBefore || sample.LoadsAfter != first.LoadsBefore ||
			sample.Observation.Current.DocumentID != first.Observation.Current.DocumentID || !sample.Observation.Current.SameDocument {
			reasons = append(reasons, "document-load-discontinuity")
			break
		}
	}
	for _, sample := range samples {
		if sample.Observation.Current.Errors != 0 || sample.Observation.Current.Rejections != 0 || sample.Observation.Current.UnknownErrors != 0 || sample.Observation.UnknownFailures != 0 {
			reasons = append(reasons, "runtime-errors")
			break
		}
	}
	for _, sample := range samples {
		if startupObservedUnsafe(sample.Observation) {
			reasons = append(reasons, "observed-unsafe-surface")
			break
		}
	}
	last := samples[len(samples)-1].Observation
	if !startupSurfaceSafe(last) || !last.FinalSurfaceSafe {
		reasons = append(reasons, "final-surface-unsafe")
	}
	return len(reasons) == 0, reasons
}

func validStartupSnapshot(s startupSnapshotDTO) bool {
	if !startupDocumentID.MatchString(s.DocumentID) || s.Revision < 0 || s.Errors < 0 || s.Rejections < 0 || s.UnknownErrors < 0 ||
		s.Modals < 0 || s.Unknown < 0 || s.Drawers < 0 || s.Settings < 0 || s.RafCount < 0 || s.RafCount > 4 || s.TimerCount < 0 || s.TimerCount > 60 || len(s.Nodes) > 4 {
		return false
	}
	if s.Visibility != "visible" && s.Visibility != "hidden" && s.Visibility != "prerender" {
		return false
	}
	if s.APIID != "unavailable" && !regexp.MustCompile(`^[1-9][0-9]{0,8}$`).MatchString(s.APIID) {
		return false
	}
	for _, node := range s.Nodes {
		if node.Kind != "agreement" && node.Kind != "login" && node.Kind != "unknown" {
			return false
		}
		for _, style := range []startupNodeStyle{node.Container, node.Mask, node.Wrapper, node.Inner} {
			if style.ID < 0 || len(style.Rect) > 4 || len(style.Phases) > 6 {
				return false
			}
			for _, phase := range style.Phases {
				if !regexp.MustCompile(`^fade-in-scale-up-transition-(enter|leave)-(from|active|to)$`).MatchString(phase) {
					return false
				}
			}
			for _, text := range []string{style.Display, style.Visibility} {
				if !regexp.MustCompile(`^(|unavailable|none|block|inline|inline-block|flex|inline-flex|grid|contents|visible|hidden|collapse)$`).MatchString(text) {
					return false
				}
			}
			for _, text := range []string{style.Opacity, style.TransitionDuration, style.TransitionDelay, style.AnimationDuration, style.AnimationDelay} {
				if len(text) > 96 || !regexp.MustCompile(`^(unavailable|[0-9., ms-]*)$`).MatchString(text) {
					return false
				}
			}
			if len(style.Transform) > 96 || !regexp.MustCompile(`^(|unavailable|none|matrix(3d)?\([-0-9., e]+\))$`).MatchString(style.Transform) {
				return false
			}
		}
	}
	return true
}

// Do not inspect Error(): SDK errors may contain JS messages, URLs or data.
func startupErrorCategory(err error) string {
	if err == nil {
		return "none"
	}
	return "unknown"
}
