//go:build !darwin && !linux

package main

func configureNativeWebViewMedia(uintptr) error { return nil }
