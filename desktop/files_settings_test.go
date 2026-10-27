package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func validRendererSettings() RendererSettings {
	return RendererSettings{SettingStore: `{"language":"zh-CN","localFilesPath":["display-only"]}`, ShortcutStore: `{"globalOpen":false}`}
}

func TestRendererSettingsRoundTripAndLegacyIsolation(t *testing.T) {
	settings := validRendererSettings()
	data, err := encodeRendererSettings(settings)
	if err != nil {
		t.Fatal(err)
	}
	document, err := decodeRendererSettings(data)
	if err != nil || document.Renderer != settings || document.Format != settingsFormat || document.Version != 1 {
		t.Fatalf("round trip failed: %v", err)
	}
	var exported map[string]json.RawMessage
	if err := json.Unmarshal(data, &exported); err != nil {
		t.Fatal(err)
	}
	if len(exported) != 3 || exported["electron"] != nil || exported["auth"] != nil {
		t.Fatal("native section exported")
	}
	legacy, err := json.Marshal(struct {
		Version   string            `json:"version"`
		Timestamp int               `json:"timestamp"`
		Electron  map[string]string `json:"electron"`
		Renderer  RendererSettings  `json:"renderer"`
	}{"1.0.4", 123, map[string]string{"closeAppMethod": "hide", "syntheticNativeMarker": "not-renderer"}, settings})
	if err != nil {
		t.Fatal(err)
	}
	extracted, err := decodeRendererSettings(legacy)
	if err != nil || extracted != document {
		t.Fatalf("legacy extraction failed: %v", err)
	}
	normalized, err := encodeRendererSettings(extracted.Renderer)
	if err != nil || strings.Contains(string(normalized), "syntheticNativeMarker") {
		t.Fatal("native section escaped isolation")
	}
}

func TestRendererSettingsRejectMalformedTransport(t *testing.T) {
	good, err := encodeRendererSettings(validRendererSettings())
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"version":            strings.Replace(string(good), `"version":1`, `"version":2`, 1),
		"format":             strings.Replace(string(good), settingsFormat, "other", 1),
		"native-section":     strings.Replace(string(good), `"format":`, `"electron":{},"format":`, 1),
		"duplicate":          strings.Replace(string(good), `"version":1`, `"version":1,"version":1`, 1),
		"unknown-store":      `{"format":"he-music-renderer-settings","version":1,"renderer":{"auth-store":"{}","shortcut-store":"{}"}}`,
		"missing-store":      `{"format":"he-music-renderer-settings","version":1,"renderer":{"setting-store":"{}"}}`,
		"native-only":        `{"electron":{"closeAppMethod":"hide"}}`,
		"null-renderer":      `{"version":"1.0.4","timestamp":1,"renderer":null}`,
		"broken":             string(good[:len(good)-1]),
		"trailing":           string(good) + ` {}`,
		"oversized":          strings.Repeat(" ", settingsMaxBytes+1),
		"deep-envelope":      `{"x":` + strings.Repeat("[", 40) + `0` + strings.Repeat("]", 40) + `}`,
		"dangerous-envelope": `{"__proto__":{}}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeRendererSettings([]byte(input)); err == nil {
				t.Fatal("invalid transport accepted")
			}
		})
	}
}

func TestRendererSettingsRejectUnsafeObjectStrings(t *testing.T) {
	cases := map[string]string{
		"null": "null", "array": "[]", "number": "3", "invalid": "{", "empty": "",
		"prototype":   `{"nested":{"__proto__":{}}}`,
		"constructor": `{"constructor":0}`, "prototype-key": `{"prototype":true}`,
		"escaped-key":  `{"\u005f_proto__":{}}`,
		"duplicate":    `{"a":1,"a":2}`,
		"deep":         `{"nested":` + strings.Repeat("[", settingsMaxDepth) + `0` + strings.Repeat("]", settingsMaxDepth) + `}`,
		"oversized":    `{"value":"` + strings.Repeat("x", settingsMaxBytes) + `"}`,
		"long-key":     `{"` + strings.Repeat("x", 257) + `":0}`,
		"invalid-utf8": string([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}),
	}
	var many strings.Builder
	many.WriteByte('{')
	for i := 0; i <= settingsMaxKeys; i++ {
		if i != 0 {
			many.WriteByte(',')
		}
		key, _ := json.Marshal(i)
		many.WriteByte('"')
		many.Write(key)
		many.WriteString(`":0`)
	}
	many.WriteByte('}')
	cases["many-keys"] = many.String()
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			settings := validRendererSettings()
			settings.SettingStore = value
			if _, err := encodeRendererSettings(settings); err == nil {
				t.Fatal("unsafe settings accepted")
			}
		})
	}
}
