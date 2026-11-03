//go:build !linux

package main

import "github.com/egoist/mygo"

func setLyricsIgnoreMouseEvents(win *mygo.Window, ignored bool) error {
	win.SetIgnoreMouseEvents(ignored)
	return nil
}
