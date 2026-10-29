//go:build !windows || (!amd64 && !arm64)

package main

import "errors"

func openTaskbar(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) {
	return nil, errors.New("taskbar requires 64-bit Windows")
}
