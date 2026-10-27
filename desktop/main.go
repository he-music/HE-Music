//go:build !nativeprobe

package main

import (
	"log"

	"github.com/egoist/mygo"
)

func main() {
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:  "HE-Music",
			Width:  1280,
			Height: 800,
			URL:    "/",
		})
		desktopLifecycle.attachMainWindow(win, true)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
