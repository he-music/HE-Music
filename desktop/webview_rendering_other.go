//go:build !linux && !windows

package main

func configureNativeLyricsRendering(uintptr) error { return nil }
