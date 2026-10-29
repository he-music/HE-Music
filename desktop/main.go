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
	gatewayOrigin, stopGateway, gatewayErr := startDesktopGateway()
	if gatewayErr != nil {
		log.Print("启动本机网络网关失败: ", gatewayErr)
		return
	}
	defer stopGateway()
	mygo.App.WhenReady(func() {
		appearance := WindowAppearance{}
		directory, directoryErr := mygo.App.Path(mygo.PathUserData)
		if directoryErr == nil {
			if err := prepareLibraryPersistence(directory); err != nil {
				log.Print("配置本地目录持久化失败")
			}
			if err := prepareLibraryIndex(directory); err != nil {
				log.Print("读取本地音乐索引失败，保留原索引并重新扫描")
			}
			var appearanceErr error
			appearance, appearanceErr = prepareWindowAppearance(directory)
			if appearanceErr != nil {
				log.Print("读取窗口外观配置失败，使用默认外观")
			}
			if proxyErr := prepareNetworkProxyStartup(directory); proxyErr != nil {
				log.Print("读取代理配置失败")
				mygo.App.Quit()
				return
			}
		} else {
			log.Print("读取应用配置目录失败")
			mygo.App.Quit()
			return
		}
		options := WindowAppearanceOptions(appearance)
		options.Title, options.Width, options.Height = "HE-Music", 1280, 800
		options.StateKey = "main"
		if gatewayOrigin != "" {
			options.Page.PreloadScript = desktopGatewayPreloadScript(gatewayOrigin)
		}
		win := mygo.NewWindow(options)
		if _, hoverErr := installWindowButtonsHover(win, appearance.UseBorderless); hoverErr != nil {
			log.Print("设置 macOS 原生窗口按钮悬停失败，保留可见按钮: ", hoverErr)
		}
		desktopLifecycle.attachMainWindow(win, true)
		win.Page().LoadURL("/")
	})
	err := mygo.App.Run()
	stopGateway()
	if cleanupErr := desktopFiles.shutdownLocalAudio(); cleanupErr != nil {
		log.Print("本地音频服务清理失败")
	}
	if err != nil {
		log.Fatal(err)
	}
}
