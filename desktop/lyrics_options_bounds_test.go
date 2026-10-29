package main

import (
	"slices"
	"testing"
)

func TestLyricsOptionsFontHeight(t *testing.T) {
	for _, test := range []struct {
		size int
		want int
	}{
		{20, 140}, {24, 152}, {25, 154}, {57, 247}, {58, 250}, {59, 253}, {96, 360},
	} {
		got, err := lyricsFontHeight(test.size)
		if err != nil || got != test.want {
			t.Errorf("size %d: got %d, %v; want %d", test.size, got, err, test.want)
		}
	}
	for _, size := range []int{-1, 0, 19, 97, 1000} {
		if got, err := lyricsFontHeight(size); err == nil || got != 0 {
			t.Errorf("invalid size %d: got %d, %v", size, got, err)
		}
	}
}

func TestLyricsOptionsBoundsForFont(t *testing.T) {
	areas := []LyricsBounds{
		{X: -1800, Y: -200, Width: 1600, Height: 1000},
		{X: 200, Y: 50, Width: 1920, Height: 1080},
	}
	for _, test := range []struct {
		name  string
		in    LyricsBounds
		size  int
		areas []LyricsBounds
		want  LyricsBounds
	}{
		{"preserve negative position and width", LyricsBounds{-1750, -150, 900, 180}, 24, areas, LyricsBounds{-1750, -150, 900, 152}},
		{"preserve position at maximum font", LyricsBounds{300, 100, 800, 140}, 96, areas, LyricsBounds{300, 100, 800, 360}},
		{"fit bottom edge after height change", LyricsBounds{300, 900, 800, 140}, 96, areas, LyricsBounds{300, 770, 800, 360}},
		{"disconnected screen gap", LyricsBounds{-100, 50, 800, 180}, 24, areas, LyricsBounds{200, 50, 800, 152}},
		{"removed screen", LyricsBounds{-1750, -150, 800, 180}, 24, areas[1:], LyricsBounds{200, 50, 800, 152}},
		{"fit narrower real screen", LyricsBounds{100, 100, 1000, 180}, 96, []LyricsBounds{{Width: 700, Height: 300}}, LyricsBounds{0, 0, 700, 300}},
		{"tiny screen keeps minimum and reachable origin", LyricsBounds{100, 100, 800, 180}, 96, []LyricsBounds{{X: -50, Y: -30, Width: 500, Height: 100}}, LyricsBounds{-50, -30, 640, 140}},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := slices.Clone(test.areas)
			got, err := lyricsBoundsForFont(test.in, test.size, test.areas)
			if err != nil || got != test.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, test.want)
			}
			if !slices.Equal(test.areas, before) {
				t.Fatal("work areas mutated")
			}
		})
	}
}

func TestLyricsOptionsBoundsForFontRejectsInvalidInput(t *testing.T) {
	areas := []LyricsBounds{{Width: 1920, Height: 1080}}
	for _, bounds := range []LyricsBounds{
		{Width: 639, Height: 180}, {Width: 1401, Height: 180},
		{X: 10000001, Width: 800, Height: 180}, {Y: -10000001, Width: 800, Height: 180},
	} {
		if got, err := lyricsBoundsForFont(bounds, 24, areas); err == nil || got != (LyricsBounds{}) {
			t.Errorf("invalid bounds %+v: got %+v, %v", bounds, got, err)
		}
	}
	bounds := LyricsBounds{Width: 800, Height: 180}
	for _, size := range []int{19, 97} {
		if got, err := lyricsBoundsForFont(bounds, size, areas); err == nil || got != (LyricsBounds{}) {
			t.Errorf("invalid size %d: got %+v, %v", size, got, err)
		}
	}
	for _, areas := range [][]LyricsBounds{nil, {}, {{Width: 0, Height: 1080}, {Width: 1920, Height: -1}}} {
		if got, err := lyricsBoundsForFont(bounds, 24, areas); err == nil || got != (LyricsBounds{}) {
			t.Errorf("invalid areas %+v: got %+v, %v", areas, got, err)
		}
	}
	// 原始高度也必须继续由既有 fitLyricsBounds 严格验证。
	for _, height := range []int{139, 361} {
		if _, err := fitLyricsBounds(LyricsBounds{Width: 800, Height: height}, areas); err == nil {
			t.Errorf("fit accepted invalid height %d", height)
		}
	}
}

func TestLyricsOptionsResetBounds(t *testing.T) {
	for _, test := range []struct {
		name  string
		areas []LyricsBounds
		size  int
		want  LyricsBounds
	}{
		{"default centered bottom margin", []LyricsBounds{{Width: 1920, Height: 1080}}, 24, LyricsBounds{560, 904, 800, 152}},
		{"minimum font", []LyricsBounds{{Width: 1920, Height: 1080}}, 20, LyricsBounds{560, 916, 800, 140}},
		{"maximum font", []LyricsBounds{{Width: 1920, Height: 1080}}, 96, LyricsBounds{560, 696, 800, 360}},
		{"negative first screen", []LyricsBounds{{X: -1800, Y: -200, Width: 1600, Height: 1000}, {X: 200, Width: 1920, Height: 1080}}, 24, LyricsBounds{-1400, 624, 800, 152}},
		{"skip unusable screens", []LyricsBounds{{Height: 1080}, {Width: 1920, Height: -1}, {X: 200, Y: 50, Width: 1920, Height: 1080}}, 24, LyricsBounds{760, 954, 800, 152}},
		{"first tiny screen remains selected", []LyricsBounds{{X: -50, Y: -30, Width: 500, Height: 100}, {Width: 1920, Height: 1080}}, 96, LyricsBounds{-50, -30, 640, 140}},
		{"fit narrow screen", []LyricsBounds{{X: 20, Y: 30, Width: 700, Height: 500}}, 24, LyricsBounds{20, 354, 700, 152}},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := slices.Clone(test.areas)
			got, err := resetLyricsBounds(test.areas, test.size)
			if err != nil || got != test.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, test.want)
			}
			if !slices.Equal(test.areas, before) {
				t.Fatal("work areas mutated")
			}
		})
	}
}

func TestLyricsOptionsResetBoundsRejectsInvalidInput(t *testing.T) {
	for _, areas := range [][]LyricsBounds{nil, {}, {{Width: -1, Height: 1080}, {Width: 1920}}} {
		if got, err := resetLyricsBounds(areas, 24); err == nil || got != (LyricsBounds{}) {
			t.Errorf("invalid areas %+v: got %+v, %v", areas, got, err)
		}
	}
	for _, size := range []int{19, 97} {
		if got, err := resetLyricsBounds([]LyricsBounds{{Width: 1920, Height: 1080}}, size); err == nil || got != (LyricsBounds{}) {
			t.Errorf("invalid size %d: got %+v, %v", size, got, err)
		}
	}
}
