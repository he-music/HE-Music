//go:build darwin

package main

import (
	"errors"
	"strconv"
	"sync"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var networkProxyDarwin struct {
	once     sync.Once
	err      error
	endpoint func(string, string) objc.ID
	tls      func() objc.ID
	connect  func(objc.ID, objc.ID) objc.ID
}

func prepareNativeNetworkProxy(NetworkProxyConfig) error { return nil }

func loadNetworkProxyDarwin() error {
	networkProxyDarwin.once.Do(func() {
		library, err := purego.Dlopen("/System/Library/Frameworks/Network.framework/Network", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			networkProxyDarwin.err = err
			return
		}
		for _, entry := range []struct {
			name   string
			target interface{}
		}{
			{"nw_endpoint_create_host", &networkProxyDarwin.endpoint},
			{"nw_tls_create_options", &networkProxyDarwin.tls},
			{"nw_proxy_config_create_http_connect", &networkProxyDarwin.connect},
		} {
			symbol, err := purego.Dlsym(library, entry.name)
			if err != nil {
				networkProxyDarwin.err = err
				return
			}
			purego.RegisterFunc(entry.target, symbol)
		}
	})
	return networkProxyDarwin.err
}

// Only public NSWindow/NSView/WKWebView selectors are used. Traversal has a hard
// node/depth budget, rejects ambiguity, and never inspects SDK object layouts.
func networkProxyDataStore(handle uintptr) objc.ID {
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
		for i := objc.ID(0); i < count; i++ {
			result = append(result, uintptr(children.Send(objc.RegisterName("objectAtIndex:"), i)))
		}
		return match, result
	})
	if found == 0 {
		return 0
	}
	configuration := objc.ID(found).Send(objc.RegisterName("configuration"))
	store := configuration.Send(objc.RegisterName("websiteDataStore"))
	if store == 0 || !objc.Send[bool](store, objc.RegisterName("respondsToSelector:"), objc.RegisterName("setProxyConfigurations:")) || !objc.Send[bool](store, objc.RegisterName("respondsToSelector:"), objc.RegisterName("proxyConfigurations")) {
		return 0
	}
	return store
}

// WKWebsiteDataStore.proxyConfigurations and nw_proxy_config_create_http_connect
// are public macOS 14+ APIs (local Xcode WebKit/Network headers). The HTTPS option
// uses default Network TLS verification; no certificate bypass is installed.
// Called on the lifecycle main thread; NativeHandle belongs to that exact owner.
func applyNativeNetworkProxy(handle uintptr, c NetworkProxyConfig) (bool, bool, string, error) {
	if _, err := networkProxyURL(c); err != nil {
		return false, false, "", err
	}
	store := networkProxyDataStore(handle)
	if store == 0 {
		return false, false, "webview-unsupported", nil
	}
	if err := loadNetworkProxyDarwin(); err != nil {
		return false, false, "webview-unsupported", nil
	}
	arrayClass := objc.ID(objc.GetClass("NSArray"))
	if arrayClass == 0 {
		return false, false, "webview-unsupported", nil
	}
	var proxy objc.ID
	if c.Protocol != "off" {
		endpoint := networkProxyDarwin.endpoint(c.Server, strconv.Itoa(c.Port))
		if endpoint == 0 {
			return false, false, "", errors.New("proxy endpoint creation failed")
		}
		defer endpoint.Send(objc.RegisterName("release"))
		var tls objc.ID
		if c.Protocol == "HTTPS" {
			tls = networkProxyDarwin.tls()
			if tls == 0 {
				return false, false, "", errors.New("proxy TLS options creation failed")
			}
			defer tls.Send(objc.RegisterName("release"))
		}
		proxy = networkProxyDarwin.connect(endpoint, tls)
		if proxy == 0 {
			return false, false, "", errors.New("proxy configuration creation failed")
		}
		defer proxy.Send(objc.RegisterName("release"))
	}
	array := arrayClass.Send(objc.RegisterName("array"))
	if proxy != 0 {
		array = arrayClass.Send(objc.RegisterName("arrayWithObject:"), proxy)
	}
	if array == 0 {
		return false, false, "", errors.New("proxy array creation failed")
	}
	previous := store.Send(objc.RegisterName("proxyConfigurations"))
	previous.Send(objc.RegisterName("retain"))
	defer previous.Send(objc.RegisterName("release"))
	store.Send(objc.RegisterName("setProxyConfigurations:"), array)
	actual := store.Send(objc.RegisterName("proxyConfigurations"))
	expected := objc.ID(0)
	if proxy != 0 {
		expected = 1
	}
	if actual.Send(objc.RegisterName("count")) != expected || (proxy != 0 && actual.Send(objc.RegisterName("objectAtIndex:"), objc.ID(0)) != proxy) {
		store.Send(objc.RegisterName("setProxyConfigurations:"), previous)
		return false, false, "", errors.New("WebKit proxy configuration readback failed")
	}
	return true, false, "", nil
}
