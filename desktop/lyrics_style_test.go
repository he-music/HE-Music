package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// 与 src/platform/desktopLyricStyle.test.ts 保持相同的 golden 输入与预期。
var lyricsStyleValidColors = []string{
	"#abc", "#ABCD", "#fe7971", "#AABBCCDD", "rgb(0,255,1)",
	"RGB( 255 , 0 , 001 )", "rgba(0, 0, 0, 0.5)", "RGBA(255,0,10,.5)",
	"rgba(0,0,0,0)", "rgba(0,0,0,1)", "rgba(0,0,0,1.000000)",
	"rgba(0,0,0,0.123456)", "rgba(0,0,0,.000001)",
	"rgb(" + strings.Repeat(" ", 54) + "0,0,0)",
}

var lyricsStyleInvalidColors = []string{
	"", "#ab", "#abcde", "#abcdefg", "#123456789", "#ggg", "red", "transparent",
	"url(x)", "var(--color)", "#abc; color:red", "rgb(0,0,0);background:url(x)",
	"rgb(256,0,0)", "rgb(0,256,0)", "rgb(0,0,256)", "rgb(-1,0,0)",
	"rgb(+1,0,0)", "rgb(1.0,0,0)", "rgb(0000,0,0)", "rgb(10%,0,0)",
	"rgb(0 0 0)", "rgb(0,0,0,1)", "rgba(0,0,0)", "rgba(0,0,0,-.1)",
	"rgba(0,0,0,1.000001)", "rgba(0,0,0,0.1234567)", "rgba(0,0,0,.1234567)",
	"rgba(0,0,0,00.5)", "rgba(0,0,0,2)", "rgba(0,0,0,1.)", "rgba(0,0,0,.)",
	"rgba(0,0,0,NaN)", "rgba(0,0,0,Infinity)", "rgba(0,0,0,1e-1)",
	"rgba(0,0,0,50%)", " rgb(0,0,0)", "rgb(0,0,0) ", "rgb (0,0,0)",
	"#abc\n", "rgb(0,0,0)\n", "rgb(0,\t0,0)", "rgb(0,\r0,0)", "rgb(0,\n0,0)",
	"rgb(0,\u00000,0)", "rgb(0,\u00a00,0)", "rgb(0,\u20030,0)", "rgb(０,0,0)",
	"rgb(" + strings.Repeat(" ", 55) + "0,0,0)",
}

func TestLyricsStyleColorGoldens(t *testing.T) {
	for _, color := range lyricsStyleValidColors {
		t.Run("valid/"+color, func(t *testing.T) {
			if !validLyricsColor(color) {
				t.Errorf("validLyricsColor(%q) = false", color)
			}
		})
	}
	for _, color := range lyricsStyleInvalidColors {
		t.Run("invalid/"+color, func(t *testing.T) {
			if validLyricsColor(color) {
				t.Errorf("validLyricsColor(%q) = true", color)
			}
		})
	}
}

func TestLyricsStyleDefaultsAndFields(t *testing.T) {
	want := LyricsStyle{
		PlayedColor: "#fe7971", UnplayedColor: "#ccc",
		ShadowColor: "rgba(0, 0, 0, 0.5)", TextBackgroundMask: false,
	}
	if got := defaultLyricsStyle(); got != want || !validLyricsStyle(got) {
		t.Fatalf("defaultLyricsStyle() = %+v, want valid %+v", got, want)
	}
	if validLyricsStyle(LyricsStyle{}) || validLyricsStyle(LyricsStyle{PlayedColor: "#abc"}) {
		t.Fatal("empty or partial struct must be invalid")
	}
	for _, field := range []string{"playedColor", "unplayedColor", "shadowColor"} {
		set := func(color string) LyricsStyle {
			style := defaultLyricsStyle()
			switch field {
			case "playedColor":
				style.PlayedColor = color
			case "unplayedColor":
				style.UnplayedColor = color
			case "shadowColor":
				style.ShadowColor = color
			}
			return style
		}
		for _, color := range lyricsStyleValidColors {
			if !validLyricsStyle(set(color)) {
				t.Errorf("%s rejects valid color %q", field, color)
			}
		}
		for _, color := range lyricsStyleInvalidColors {
			if validLyricsStyle(set(color)) {
				t.Errorf("%s accepts invalid color %q", field, color)
			}
		}
	}
}

func TestCloneLyricsStyleDetached(t *testing.T) {
	first, second := cloneLyricsStyle(nil), cloneLyricsStyle(nil)
	if first == second || *first != defaultLyricsStyle() || *second != defaultLyricsStyle() {
		t.Fatal("nil clones must be independent defaults")
	}
	first.PlayedColor = "#000"
	if second.PlayedColor != "#fe7971" || defaultLyricsStyle().PlayedColor != "#fe7971" {
		t.Fatal("default clones share mutable state")
	}
	original := LyricsStyle{
		PlayedColor: "#abcd", UnplayedColor: "#aabbcc00",
		ShadowColor: "rgba(0,0,0,0)", TextBackgroundMask: true,
	}
	clone := cloneLyricsStyle(&original)
	if clone == &original || *clone != original || !validLyricsStyle(*clone) {
		t.Fatal("non-nil clone must preserve all values including alpha and mask")
	}
	original.PlayedColor, original.UnplayedColor, original.ShadowColor = "#000", "#111", "#222"
	original.TextBackgroundMask = false
	if clone.PlayedColor != "#abcd" || clone.UnplayedColor != "#aabbcc00" ||
		clone.ShadowColor != "rgba(0,0,0,0)" || !clone.TextBackgroundMask {
		t.Fatal("mutating original changed clone")
	}
	clone.PlayedColor = "#333"
	if original.PlayedColor != "#000" || cloneLyricsStyle(&original).TextBackgroundMask {
		t.Fatal("mutating clone changed original or false mask was lost")
	}
}

func TestLyricsStyleJSON(t *testing.T) {
	style := defaultLyricsStyle()
	data, err := json.Marshal(style)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"playedColor":"#fe7971","unplayedColor":"#ccc","shadowColor":"rgba(0, 0, 0, 0.5)","textBackgroundMask":false}`
	if string(data) != want {
		t.Fatalf("JSON = %s, want %s", data, want)
	}
	var decoded LyricsStyle
	if err := json.Unmarshal(data, &decoded); err != nil || decoded != style {
		t.Fatalf("JSON roundtrip = %+v, error %v", decoded, err)
	}
}
