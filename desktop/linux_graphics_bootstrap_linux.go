//go:build linux

package main

import (
	"os"
	"syscall"

	"github.com/egoist/mygo"
)

// Replace this process before claiming the singleton or loading GTK/WebKit.
// The environment is then visible to both Go and dynamically loaded C code.
func bootstrapLinuxGraphics() error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return nil
	}
	directory, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return err
	}
	next, changed, err := desktopLinuxGraphics.prepare(directory, os.Environ())
	if err != nil || !changed {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(executable, os.Args, next)
}
