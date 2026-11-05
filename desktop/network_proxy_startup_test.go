package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNetworkProxyStartupFailureRemainsExplicit(t *testing.T) {
	t.Setenv("MYGO_GENERATE", "")
	previousErr := errNetworkProxyStartup
	t.Cleanup(func() { errNetworkProxyStartup = previousErr })
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "network-proxy.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareNetworkProxyStartup(directory); err == nil || errNetworkProxyStartup == nil {
		t.Fatal("startup failure was hidden", err)
	}
	// Fails before resolving any native window, class or API.
	if receipt, err := restoreNetworkProxyWebview(); err == nil || receipt.WebviewApplied || receipt.DownloadsApplied {
		t.Fatal(receipt, err)
	}
}
