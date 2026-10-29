package main

import (
	"errors"
	"math"
)

// 与现有歌词 SFC 的字号到窗口高度线性映射保持一致；字号由 Go int 入口约束。
func lyricsFontHeight(size int) (int, error) {
	if size < 20 || size > 96 {
		return 0, errors.New("desktop lyrics font size is invalid")
	}
	return int(math.Round(140 + float64(size-20)*220/76)), nil
}

func lyricsBoundsForFont(bounds LyricsBounds, size int, areas []LyricsBounds) (LyricsBounds, error) {
	height, err := lyricsFontHeight(size)
	if err != nil {
		return LyricsBounds{}, err
	}
	bounds.Height = height
	return fitLyricsBounds(bounds, areas)
}

func resetLyricsBounds(areas []LyricsBounds, size int) (LyricsBounds, error) {
	height, err := lyricsFontHeight(size)
	if err != nil {
		return LyricsBounds{}, err
	}
	for _, area := range areas {
		if area.Width <= 0 || area.Height <= 0 {
			continue
		}
		bounds := LyricsBounds{
			X:     area.X + (area.Width-800)/2,
			Y:     area.Y + area.Height - height - 24,
			Width: 800, Height: height,
		}
		// 重置始终选择首个有效工作区，再沿用既有的最小尺寸与可达性策略。
		return fitLyricsBounds(bounds, []LyricsBounds{area})
	}
	return LyricsBounds{}, errors.New("desktop lyrics has no usable display")
}
