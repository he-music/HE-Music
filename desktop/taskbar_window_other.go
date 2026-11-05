//go:build !windows

package main

// 非 Windows 后端仅保留执行器的通用窗口状态。
type taskbarNativeWindow struct {
	added    bool
	explorer uint64
}
