//go:build darwin

package main

import "golang.org/x/sys/unix"

func nativeDeviceModel() string {
	model, _ := unix.Sysctl("hw.model")
	return model
}
func nativeDeviceFallback() string { return "Mac" }
