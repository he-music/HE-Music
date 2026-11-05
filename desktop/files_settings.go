package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const (
	settingsMaxBytes = 1 << 20
	settingsMaxDepth = 32
	settingsMaxKeys  = 4096
	settingsFormat   = "he-music-renderer-settings"
)

var errSettingsDocument = errors.New("invalid renderer settings document")

// These are JSON object strings, not native settings or authorization records.
// The UI must additionally validate setting values against its current defaults.
type RendererSettings struct {
	SettingStore  string `json:"setting-store"`
	ShortcutStore string `json:"shortcut-store"`
}

type RendererSettingsDocument struct {
	Format   string           `json:"format"`
	Version  int              `json:"version"`
	Renderer RendererSettings `json:"renderer"`
}

func validateRendererSettings(settings RendererSettings) error {
	if len(settings.SettingStore)+len(settings.ShortcutStore) > settingsMaxBytes {
		return errSettingsDocument
	}
	for _, value := range []string{settings.SettingStore, settings.ShortcutStore} {
		if err := validateSettingsJSON([]byte(value), true); err != nil {
			return err
		}
	}
	return nil
}

// Token validation bounds nesting/key counts and rejects duplicate/prototype keys
// before decoding into concrete transport types. No settings leaf is applied here.
func validateSettingsJSON(data []byte, object bool) error {
	if len(data) == 0 || len(data) > settingsMaxBytes || !utf8.Valid(data) {
		return errSettingsDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	keys := 0
	if err := readSettingsValue(decoder, 0, object, &keys); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errSettingsDocument
	}
	return nil
}

func readSettingsValue(decoder *json.Decoder, depth int, object bool, keys *int) error {
	if depth > settingsMaxDepth {
		return errSettingsDocument
	}
	token, err := decoder.Token()
	if err != nil {
		return errSettingsDocument
	}
	delim, container := token.(json.Delim)
	if depth == 0 && object && (!container || delim != '{') {
		return errSettingsDocument
	}
	if !container {
		return nil
	}
	switch delim {
	case '{':
		return readSettingsObject(decoder, depth, keys)
	case '[':
		for decoder.More() {
			if err := readSettingsValue(decoder, depth+1, false, keys); err != nil {
				return err
			}
		}
		return readSettingsEnd(decoder, ']')
	default:
		return errSettingsDocument
	}
}

func readSettingsObject(decoder *json.Decoder, depth int, keys *int) error {
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errSettingsDocument
		}
		key, ok := token.(string)
		*keys += 1
		if !ok || *keys > settingsMaxKeys || len(key) > 256 || seen[key] || key == "__proto__" || key == "constructor" || key == "prototype" {
			return errSettingsDocument
		}
		seen[key] = true
		if err := readSettingsValue(decoder, depth+1, false, keys); err != nil {
			return err
		}
	}
	return readSettingsEnd(decoder, '}')
}

func readSettingsEnd(decoder *json.Decoder, delim json.Delim) error {
	end, err := decoder.Token()
	if err != nil || end != delim {
		return errSettingsDocument
	}
	return nil
}

func encodeRendererSettings(settings RendererSettings) ([]byte, error) {
	if err := validateRendererSettings(settings); err != nil {
		return nil, err
	}
	data, err := json.Marshal(RendererSettingsDocument{Format: settingsFormat, Version: 1, Renderer: settings})
	if err != nil || len(data) > settingsMaxBytes {
		return nil, errSettingsDocument
	}
	return data, nil
}

func decodeSettingsEnvelope(data []byte, envelope map[string]json.RawMessage) (RendererSettingsDocument, error) {
	var result RendererSettingsDocument
	if _, modern := envelope["format"]; modern {
		if len(envelope) != 3 || json.Unmarshal(data, &result) != nil || result.Format != settingsFormat || result.Version != 1 {
			return RendererSettingsDocument{}, errSettingsDocument
		}
		for key := range envelope {
			if key != "format" && key != "version" && key != "renderer" {
				return RendererSettingsDocument{}, errSettingsDocument
			}
		}
		return result, nil
	}
	// Known Electron export envelope: discard electron completely, never apply it.
	for key := range envelope {
		if key != "version" && key != "timestamp" && key != "renderer" && key != "electron" {
			return result, errSettingsDocument
		}
	}
	var version string
	var timestamp json.Number
	if json.Unmarshal(envelope["version"], &version) != nil || version == "" || json.Unmarshal(envelope["timestamp"], &timestamp) != nil || timestamp == "" {
		return result, errSettingsDocument
	}
	result.Format, result.Version = settingsFormat, 1
	return result, nil
}

func decodeRendererSettings(data []byte) (RendererSettingsDocument, error) {
	var result RendererSettingsDocument
	if err := validateSettingsJSON(data, true); err != nil {
		return result, err
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(data, &envelope) != nil {
		return result, errSettingsDocument
	}
	decoded, err := decodeSettingsEnvelope(data, envelope)
	if err != nil {
		return result, err
	}
	result = decoded
	var stores map[string]json.RawMessage
	if json.Unmarshal(envelope["renderer"], &stores) != nil || len(stores) != 2 {
		return RendererSettingsDocument{}, errSettingsDocument
	}
	for key := range stores {
		if key != "setting-store" && key != "shortcut-store" {
			return RendererSettingsDocument{}, errSettingsDocument
		}
	}
	if json.Unmarshal(envelope["renderer"], &result.Renderer) != nil {
		return RendererSettingsDocument{}, errSettingsDocument
	}
	if err := validateRendererSettings(result.Renderer); err != nil {
		return RendererSettingsDocument{}, err
	}
	return result, nil
}
