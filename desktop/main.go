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
	err := mygo.App.Run()
	if cleanupErr := desktopFiles.shutdownLocalAudio(); cleanupErr != nil {
		log.Print("本地音频服务清理失败")
	}
	if err != nil {
		log.Fatal(err)
	}
}
