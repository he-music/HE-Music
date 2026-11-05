//go:build !nativeprobe

package main

import (
	"log"

	"github.com/egoist/mygo"
)

func main() {
	if err := bootstrapLinuxGraphics(); err != nil {
		log.Print("初始化 Linux 图形设置失败: ", err)
		return
	}
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
	stopLogging := func() {}
	defer func() { stopLogging() }()
	mygo.App.WhenReady(func() {
		if stop, err := configureDesktopLogging(); err != nil {
			log.Print("配置文件日志失败，继续输出到控制台: ", err)
		} else {
			stopLogging = stop
		}
		appearance := WindowAppearance{}
		directory, directoryErr := mygo.App.Path(mygo.PathUserData)
		if directoryErr == nil {
			if err := preparePreferencesResetStartup(directory); err != nil {
				log.Print("恢复设置重置失败")
				mygo.App.Quit()
				return
			}
			if err := prepareApplicationStorage(directory); err != nil {
				log.Print("配置业务数据存储失败: ", err)
				mygo.App.Quit()
				return
			}
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
		options.MinWidth, options.MinHeight = 800, 600
		options.StateKey = "main"
		if gatewayOrigin != "" {
			options.Page.PreloadScript = desktopGatewayPreloadScript(gatewayOrigin)
		}
		win := mygo.NewWindow(options)
		if mediaErr := configureNativeWebViewMedia(win.NativeHandle()); mediaErr != nil {
			log.Print("配置 WebView 媒体策略失败，保留默认设置: ", mediaErr)
		}
		if _, hoverErr := installWindowButtonsHover(win, appearance.UseBorderless); hoverErr != nil {
			log.Print("设置 macOS 原生窗口按钮悬停失败，保留可见按钮: ", hoverErr)
		}
		desktopLifecycle.attachMainWindow(win, true)
		if err := win.Page().LoadURL("/"); err != nil {
			log.Print("加载主窗口失败: ", err)
			mygo.App.Quit()
		}
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
