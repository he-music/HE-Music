//go:build !nativeprobe

package main

import (
	"log"

	"github.com/egoist/mygo"
)

func main() {
	acquired, stopProtocols := installProtocolHooks()
	if !acquired {
		return
	}
	defer stopProtocols()
	mygo.App.WhenReady(func() {
		appearance := WindowAppearance{}
		directory, directoryErr := mygo.App.Path(mygo.PathUserData)
		if directoryErr == nil {
			var appearanceErr error
			appearance, appearanceErr = prepareWindowAppearance(directory)
			if appearanceErr != nil {
				log.Print("读取窗口外观配置失败，使用默认外观")
			}
			if proxyErr := prepareNetworkProxyStartup(directory); proxyErr != nil {
				log.Print("读取代理配置失败")
			}
		} else {
			log.Print("读取应用配置目录失败")
		}
		options := WindowAppearanceOptions(appearance)
		options.Title, options.Width, options.Height = "HE-Music", 1280, 800
		win := mygo.NewWindow(options)
		if _, hoverErr := installWindowButtonsHover(win, appearance.UseBorderless); hoverErr != nil {
			log.Print("设置 macOS 原生窗口按钮悬停失败，保留可见按钮: ", hoverErr)
		}
		desktopLifecycle.attachMainWindow(win, true)
		if _, proxyErr := restoreNetworkProxyWebview(); proxyErr != nil {
			log.Print("恢复代理配置失败")
		}
		win.Page().LoadURL("/")
	})
	err := mygo.App.Run()
	if cleanupErr := desktopFiles.shutdownLocalAudio(); cleanupErr != nil {
		log.Print("本地音频服务清理失败")
	}
	if err != nil {
		log.Fatal(err)
	}
}
