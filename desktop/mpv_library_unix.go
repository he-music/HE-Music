//go:build darwin || linux

package main

import "github.com/ebitengine/purego"

func openMpvLibrary(path string) (uintptr, error) {
	return purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
}

func closeMpvLibrary(handle uintptr) { _ = purego.Dlclose(handle) }
