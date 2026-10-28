package main

import (
	"regexp"
	"strconv"
)

type LyricsStyle struct {
	PlayedColor        string `json:"playedColor"`
	UnplayedColor      string `json:"unplayedColor"`
	ShadowColor        string `json:"shadowColor"`
	TextBackgroundMask bool   `json:"textBackgroundMask"`
}

func defaultLyricsStyle() LyricsStyle {
	return LyricsStyle{
		PlayedColor: "#fe7971", UnplayedColor: "#ccc",
		ShadowColor: "rgba(0, 0, 0, 0.5)", TextBackgroundMask: false,
	}
}

// 与 src/platform/desktopLyricStyle.ts 共用有限语法：无外围空格，函数内仅允许 ASCII 空格。
var (
	lyricsHexColor  = regexp.MustCompile(`(?i)^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$`)
	lyricsRGBColor  = regexp.MustCompile(`(?i)^rgb\( *([0-9]{1,3}) *, *([0-9]{1,3}) *, *([0-9]{1,3}) *\)$`)
	lyricsRGBAColor = regexp.MustCompile(`(?i)^rgba\( *([0-9]{1,3}) *, *([0-9]{1,3}) *, *([0-9]{1,3}) *, *(0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?|\.[0-9]{1,6}) *\)$`)
)

func validLyricsColor(value string) bool {
	if len(value) > 64 {
		return false
	}
	if lyricsHexColor.MatchString(value) {
		return true
	}
	channels := lyricsRGBColor.FindStringSubmatch(value)
	if channels == nil {
		channels = lyricsRGBAColor.FindStringSubmatch(value)
	}
	if channels == nil {
		return false
	}
	for _, channel := range channels[1:4] {
		n, err := strconv.Atoi(channel)
		if err != nil || n > 255 {
			return false
		}
	}
	return true
}

func validLyricsStyle(style LyricsStyle) bool {
	return validLyricsColor(style.PlayedColor) && validLyricsColor(style.UnplayedColor) &&
		validLyricsColor(style.ShadowColor)
}

func cloneLyricsStyle(style *LyricsStyle) *LyricsStyle {
	if style == nil {
		defaults := defaultLyricsStyle()
		return &defaults
	}
	clone := *style
	return &clone
}
