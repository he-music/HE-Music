//go:build !darwin && !windows

package main

func prepareNativeNetworkProxy(NetworkProxyConfig) error { return nil }
func applyNativeNetworkProxy(uintptr, NetworkProxyConfig) (bool, bool, string, error) {
	return false, false, "webview-unsupported", nil
}
