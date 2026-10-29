//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

var startupNetworkProxy = NetworkProxyConfig{Protocol: "off"}
var startupNetworkProxyPrepared bool

// The fixed SDK can bypass the official loader and invoke a runtime-internal
// export. Do not assume that route consumes loader environment overrides.
func networkProxyOfficialWebviewLoader() bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	loader := syscall.NewLazyDLL(filepath.Join(filepath.Dir(executable), "WebView2Loader.dll"))
	return loader.NewProc("CreateCoreWebView2EnvironmentWithOptions").Find() == nil
}

// Official WebView2 environment switch, consumed only when the environment is
// created. Do not rewrite existing caller flags or imply live application.
func prepareNativeNetworkProxy(c NetworkProxyConfig) error {
	if _, err := networkProxyURL(c); err != nil {
		return err
	}
	if !networkProxyOfficialWebviewLoader() {
		return nil
	}
	existing := os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
	args, err := networkProxyWindowsArguments(existing, c)
	if err != nil {
		return err
	}
	if err = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args); err != nil {
		return err
	}
	startupNetworkProxy = c
	startupNetworkProxyPrepared = true
	return nil
}
func applyNativeNetworkProxy(handle uintptr, c NetworkProxyConfig) (bool, bool, string, error) {
	if _, err := networkProxyURL(c); err != nil {
		return false, false, "", err
	}
	if !startupNetworkProxyPrepared || handle == 0 {
		return false, false, "webview-unsupported", nil
	}
	if c == startupNetworkProxy {
		return true, false, "", nil
	}
	return false, true, "", nil
}
