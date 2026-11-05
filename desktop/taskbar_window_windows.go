//go:build windows

package main

// HWND 的物理状态跨 COM 后端重开保留，包括同一组按钮 ID。
type taskbarNativeWindow struct {
	added     bool
	explorer  uint64
	buttonIDs [3]uint32
}
