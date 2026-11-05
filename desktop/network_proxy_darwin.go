//go:build darwin

package main

import "github.com/ebitengine/purego/objc"

// Only public NSWindow/NSView/WKWebView selectors are used. Traversal has a hard
// node/depth budget, rejects ambiguity, and never inspects SDK object layouts.
func nativeWebView(handle uintptr) objc.ID {
	if handle == 0 {
		return 0
	}
	window := objc.ID(handle)
	windowClass := objc.GetClass("NSWindow")
	webviewClass := objc.GetClass("WKWebView")
	if windowClass == 0 || webviewClass == 0 || !objc.Send[bool](window, objc.RegisterName("isKindOfClass:"), windowClass) {
		return 0
	}
	root := window.Send(objc.RegisterName("contentView"))
	found := findNetworkProxyWebview(uintptr(root), func(view uintptr) (bool, []uintptr) {
		id := objc.ID(view)
		match := objc.Send[bool](id, objc.RegisterName("isKindOfClass:"), webviewClass)
		children := id.Send(objc.RegisterName("subviews"))
		count := children.Send(objc.RegisterName("count"))
		if count > 256 {
			return match, make([]uintptr, 257)
		}
		result := make([]uintptr, 0, int(count))
		for i := range count {
			result = append(result, uintptr(children.Send(objc.RegisterName("objectAtIndex:"), i)))
		}
		return match, result
	})
	return objc.ID(found)
}
