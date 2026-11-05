package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strconv"
	"strings"
)

const protocolQueueLimit = 16

type ProtocolSession struct {
	Epoch uint64 `json:"epoch"`
}
type ProtocolIntent struct {
	Epoch    uint64 `json:"epoch"`
	Sequence uint64 `json:"sequence"`
	Platform string `json:"platform"`
	SongID   string `json:"songId"`
}
type ProtocolResult struct {
	Scheme     string `json:"scheme"`
	Selected   bool   `json:"selected"`
	Registered bool   `json:"registered"`
	Status     string `json:"status"`
	Reason     string `json:"reason,omitempty"`
}
type ProtocolStatus struct {
	Epoch   uint64           `json:"epoch"`
	Results []ProtocolResult `json:"results"`
}
type protocolBackend interface {
	RegisterURLScheme(string) error
	UnregisterURLScheme(string) error
	IsURLSchemeRegistered(string) bool
}

// Only typed candidates survive parsing. Raw URLs are never retained or emitted.
func parseProtocolURL(raw string) (ProtocolIntent, bool) {
	intent := ProtocolIntent{}
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\t #@") {
		return intent, false
	}
	var id string
	var ok bool
	switch {
	case strings.HasPrefix(raw, "orpheus://"):
		id, ok = parseOrpheusSongID(strings.TrimPrefix(raw, "orpheus://"))
		intent.Platform = "netease"
	case strings.HasPrefix(raw, "kuwo://"):
		id, ok = parseKuwoSongID(raw)
		intent.Platform = "kuwo"
	}
	if !ok || !validProtocolSongID(id) {
		return ProtocolIntent{}, false
	}
	intent.SongID = id
	return intent, true
}

func parseOrpheusSongID(encoded string) (string, bool) {
	decoded, err := url.PathUnescape(strings.TrimSuffix(encoded, "/"))
	if err != nil {
		return "", false
	}
	payload, ok := decodeProtocolBase64(decoded)
	if !ok {
		return "", false
	}
	return decodeOrpheusSong(payload)
}

func decodeOrpheusSong(payload []byte) (string, bool) {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return "", false
	}
	fields := map[string]string{}
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return "", false
		}
		key, ok := token.(string)
		if !ok || (key != "type" && key != "id" && key != "cmd") {
			return "", false
		}
		if _, exists := fields[key]; exists {
			return "", false
		}
		var value string
		if decoder.Decode(&value) != nil {
			return "", false
		}
		fields[key] = value
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return "", false
	}
	if _, err = decoder.Token(); err != io.EOF {
		return "", false
	}
	if len(fields) != 3 || fields["type"] != "song" || fields["cmd"] != "play" {
		return "", false
	}
	return fields["id"], true
}

func parseKuwoSongID(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host != "play" || parsed.User != nil || parsed.Path != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return "", false
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || len(query) != 1 || len(query["musicrid0"]) != 1 {
		return "", false
	}
	payload, ok := decodeProtocolBase64(query["musicrid0"][0])
	if !ok || !strings.HasPrefix(string(payload), "MUSIC_") {
		return "", false
	}
	return strings.TrimPrefix(string(payload), "MUSIC_"), true
}

func validProtocolSongID(id string) bool {
	if len(id) == 0 || len(id) > 16 || id[0] == '0' {
		return false
	}
	for _, char := range id {
		if char < '0' || char > '9' {
			return false
		}
	}
	numeric, err := strconv.ParseUint(id, 10, 64)
	return err == nil && numeric <= 9007199254740991
}

func decodeProtocolBase64(encoded string) ([]byte, bool) {
	if encoded == "" || len(encoded) > 1536 || strings.ContainsAny(encoded, "\r\n\t ") {
		return nil, false
	}
	for _, encoding := range []*base64.Encoding{base64.StdEncoding.Strict(), base64.RawStdEncoding.Strict(), base64.URLEncoding.Strict(), base64.RawURLEncoding.Strict()} {
		if decoded, err := encoding.DecodeString(encoded); err == nil {
			return decoded, true
		}
	}
	return nil, false
}

type protocolState struct {
	backend    protocolBackend
	goos       string
	owner      context.Context
	epoch      uint64
	sequence   uint64
	started    bool
	configured bool
	enabled    map[string]bool
	pending    []ProtocolIntent
}

func (s *protocolState) begin(ctx context.Context) (uint64, error) {
	if s.owner != nil || s.epoch >= 9007199254740991 {
		return 0, errors.New("protocol session unavailable")
	}
	s.epoch++
	s.owner = ctx
	s.started = true
	s.configured = false
	return s.epoch, nil
}

func (s *protocolState) owns(ctx context.Context, epoch uint64) bool {
	return s.owner == ctx && ctx.Err() == nil && epoch == s.epoch
}

func (s *protocolState) receive(raw string) {
	intent, ok := parseProtocolURL(raw)
	if !ok {
		return
	}
	// After revocation, input cannot be inherited by a future renderer owner.
	if s.started && (s.owner == nil || s.owner.Err() != nil) {
		return
	}
	scheme := "orpheus"
	if intent.Platform == "kuwo" {
		scheme = "kuwo"
	}
	if s.configured && !s.enabled[scheme] {
		return
	}
	if len(s.pending) >= protocolQueueLimit {
		return
	}
	// Merge only undelivered candidates. A later click after drain is a new intent.
	for _, pending := range s.pending {
		if pending.Platform == intent.Platform && pending.SongID == intent.SongID {
			return
		}
	}
	s.pending = append(s.pending, intent)
}

func (s *protocolState) drain() []ProtocolIntent {
	events := []ProtocolIntent{}
	if s.owner == nil || s.owner.Err() != nil || !s.configured {
		return events
	}
	for _, intent := range s.pending {
		scheme := "orpheus"
		if intent.Platform == "kuwo" {
			scheme = "kuwo"
		}
		if !s.enabled[scheme] {
			continue
		}
		s.sequence++
		intent.Epoch = s.epoch
		intent.Sequence = s.sequence
		events = append(events, intent)
	}
	s.pending = nil
	return events
}

func (s *protocolState) sync(ctx context.Context, epoch uint64, schemes []string) (ProtocolStatus, []ProtocolIntent, error) {
	status := ProtocolStatus{Epoch: s.epoch, Results: []ProtocolResult{}}
	if !s.owns(ctx, epoch) {
		return status, nil, errors.New("protocol owner expired")
	}
	selected := map[string]bool{}
	if len(schemes) > 2 {
		return status, nil, errors.New("invalid protocol selection")
	}
	for _, scheme := range schemes {
		if (scheme != "orpheus" && scheme != "kuwo") || selected[scheme] {
			return status, nil, errors.New("invalid protocol selection")
		}
		selected[scheme] = true
	}
	if s.epoch >= 9007199254740991 {
		return status, nil, errors.New("protocol epoch exhausted")
	}
	s.epoch++
	status.Epoch = s.epoch
	s.enabled = map[string]bool{}
	for _, scheme := range []string{"orpheus", "kuwo"} {
		result := ProtocolResult{Scheme: scheme, Selected: selected[scheme]}
		if selected[scheme] {
			if err := s.backend.RegisterURLScheme(scheme); err != nil {
				result.Status = "registration-failed"
				result.Reason = "association-failed"
				var failure interface{ ProtocolRegistrationReason() string }
				if errors.As(err, &failure) {
					switch reason := failure.ProtocolRegistrationReason(); reason {
					case "missing-declaration", "bundle-registration-failed":
						result.Reason = reason
					}
				}
			} else {
				result.Status = "registered"
			}
		} else if s.goos == "darwin" {
			result.Status = "disabled"
		} else if err := s.backend.UnregisterURLScheme(scheme); err != nil {
			result.Status = "unregistration-failed"
		} else {
			result.Status = "unregistered"
		}
		result.Registered = s.backend.IsURLSchemeRegistered(scheme)
		if result.Status == "registered" && !result.Registered {
			result.Status = "registration-failed"
			result.Reason = "not-default"
		}
		if result.Status == "unregistered" && result.Registered {
			result.Status = "unregistration-failed"
		}
		s.enabled[scheme] = result.Selected && result.Status == "registered"
		status.Results = append(status.Results, result)
	}
	s.configured = true
	return status, s.drain(), nil
}

func (s *protocolState) revoke() {
	if !s.started {
		return
	}
	s.owner = nil
	s.enabled = nil
	s.pending = nil
	s.configured = false
	s.started = true
}
