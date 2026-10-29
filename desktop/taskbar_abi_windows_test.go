//go:build windows && (amd64 || arm64)

package main

import "unsafe"

// Compile-time checks for the published 64-bit THUMBBUTTON ABI; never execute Windows.
var (
	_ [552 - unsafe.Sizeof(taskbarButton{})]byte
	_ [unsafe.Sizeof(taskbarButton{}) - 552]byte
	_ [16 - unsafe.Offsetof(taskbarButton{}.Icon)]byte
	_ [unsafe.Offsetof(taskbarButton{}.Icon) - 16]byte
	_ [24 - unsafe.Offsetof(taskbarButton{}.Tip)]byte
	_ [unsafe.Offsetof(taskbarButton{}.Tip) - 24]byte
	_ [544 - unsafe.Offsetof(taskbarButton{}.Flags)]byte
	_ [unsafe.Offsetof(taskbarButton{}.Flags) - 544]byte
)
