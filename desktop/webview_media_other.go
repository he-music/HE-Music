//go:build !darwin

package main

func configureNativeWebViewMedia(uintptr) error { return nil }
