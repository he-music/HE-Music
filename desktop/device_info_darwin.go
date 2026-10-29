//go:build darwin

package main

import "syscall"

func nativeDeviceModel() string {
	model, _ := syscall.Sysctl("hw.model")
	return model
}
func nativeDeviceFallback() string { return "Mac" }
