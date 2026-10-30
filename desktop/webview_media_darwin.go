//go:build darwin

package main

import (
	"errors"

	"github.com/ebitengine/purego/objc"
)

// Called on the main thread, after NewWindow and before the first LoadURL.
// WebKit gates navigator.mediaDevices on this preference as well as the page's
// security context. It is private API: check both selectors before messaging,
// verify the result, and retain default playback if this WebKit lacks support.
// Enabling the API does not request capture or change the permission handler.
func configureNativeWebViewMedia(handle uintptr) error {
	webview := nativeWebView(handle)
	if webview == 0 {
		return errors.New("WKWebView 不可用")
	}
	preferences := webview.Send(objc.RegisterName("configuration")).Send(objc.RegisterName("preferences"))
	return enableWebViewMediaDevices(preferences)
}

func enableWebViewMediaDevices(preferences objc.ID) error {
	getter := objc.RegisterName("_mediaDevicesEnabled")
	setter := objc.RegisterName("_setMediaDevicesEnabled:")
	if preferences == 0 ||
		!objc.Send[bool](preferences, objc.RegisterName("respondsToSelector:"), getter) ||
		!objc.Send[bool](preferences, objc.RegisterName("respondsToSelector:"), setter) {
		return errors.New("当前 WebKit 不支持媒体设备配置")
	}
	if objc.Send[bool](preferences, getter) {
		return nil
	}
	preferences.Send(setter, uintptr(1))
	if !objc.Send[bool](preferences, getter) {
		preferences.Send(setter, uintptr(0))
		return errors.New("WebKit 媒体设备配置未生效")
	}
	return nil
}
