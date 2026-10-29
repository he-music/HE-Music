package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

type LyricsFontOptions struct {
	Family         string `json:"family"`
	Size           int    `json:"size"`
	Weight         int    `json:"weight"`
	PostScriptName string `json:"postScriptName"`
	Style          string `json:"style"`
}

type LyricsOptions struct {
	Font               LyricsFontOptions `json:"font"`
	IsDoubleLine       bool              `json:"isDoubleLine"`
	Position           string            `json:"position"`
	LimitBounds        bool              `json:"limitBounds"`
	ShowYrc            bool              `json:"showYrc"`
	ShowTran           bool              `json:"showTran"`
	Animation          bool              `json:"animation"`
	AlwaysShowPlayInfo bool              `json:"alwaysShowPlayInfo"`
}

func defaultLyricsOptions() LyricsOptions {
	return LyricsOptions{
		Font: LyricsFontOptions{
			Family: "system-ui", Size: 24, Weight: 700,
			PostScriptName: "system-ui", Style: "normal",
		},
		IsDoubleLine: true, Position: "both", LimitBounds: false,
		ShowYrc: true, ShowTran: true, Animation: true, AlwaysShowPlayInfo: false,
	}
}

// 与 src/platform/desktopLyricOptions.ts 一致：单一字体名，UTF-8 至多 256 字节。
func validLyricsFontName(value string) bool {
	if len(value) == 0 || len(value) > 256 || !utf8.ValidString(value) ||
		strings.HasPrefix(value, " ") || strings.HasSuffix(value, " ") {
		return false
	}
	for _, r := range value {
		if !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != ' ' && r != '_' && r != '-' && r != '.' {
			return false
		}
	}
	return true
}

// nil 兼容整个配置缺省；非 nil 必须包含有效的完整字体与位置。
func validLyricsOptions(options *LyricsOptions) bool {
	if options == nil {
		return true
	}
	font := options.Font
	return validLyricsFontName(font.Family) && validLyricsFontName(font.PostScriptName) &&
		font.Size >= 20 && font.Size <= 96 &&
		font.Weight >= 100 && font.Weight <= 900 && font.Weight%100 == 0 &&
		(font.Style == "normal" || font.Style == "italic" || font.Style == "oblique") &&
		(options.Position == "left" || options.Position == "center" ||
			options.Position == "right" || options.Position == "both")
}

func cloneLyricsOptions(options *LyricsOptions) *LyricsOptions {
	if options == nil {
		defaults := defaultLyricsOptions()
		return &defaults
	}
	clone := *options
	return &clone
}
