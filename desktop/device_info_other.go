//go:build !darwin && !linux && !windows

package main

func nativeDeviceModel() string    { return "" }
func nativeDeviceFallback() string { return "Desktop" }
