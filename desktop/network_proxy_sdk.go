package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

var (
	errNetworkProxyStartup = errors.New("network proxy storage not configured")
	desktopNetworkProxy    = newNetworkProxy(
		func(NetworkProxyConfig) error { return errors.New("network proxy storage not configured") },
		func(NetworkProxyConfig) (bool, bool, string, error) {
			// Go transports read the committed configuration on each request.
			return true, false, "", nil
		},
	)
)

func init() { mygo.Bind(desktopNetworkProxy) }

func (p *NetworkProxy) Apply(ctx context.Context, c NetworkProxyConfig) (NetworkProxyReceipt, error) {
	result := NetworkProxyReceipt{}
	err := desktopLifecycle.call(ctx, true, func() error {
		if errNetworkProxyStartup != nil {
			return errNetworkProxyStartup
		}
		var err error
		result, err = p.apply(c)
		return err
	})
	return result, err
}

// Authorization is checked before starting and again after the isolated request.
// A response belonging to a replaced page owner is never returned as success.
func (p *NetworkProxy) Test(ctx context.Context, c NetworkProxyConfig) (NetworkProxyTestResult, error) {
	return p.testForOwner(ctx, c, func(ctx context.Context) error {
		return desktopLifecycle.call(ctx, true, func() error { return nil })
	})
}

func (p *NetworkProxy) Current(ctx context.Context) (NetworkProxyConfig, error) {
	result := NetworkProxyConfig{}
	err := desktopLifecycle.call(ctx, true, func() error {
		if errNetworkProxyStartup != nil {
			return errNetworkProxyStartup
		}
		p.mu.RLock()
		defer p.mu.RUnlock()
		result = p.config
		return nil
	})
	return result, err
}

func readNetworkProxyConfig(path string) (NetworkProxyConfig, error) {
	c := NetworkProxyConfig{Protocol: "off"}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1025))
	if err != nil {
		return c, err
	}
	if len(data) > 1024 {
		return c, errNetworkProxyConfig
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	if _, err = networkProxyURL(c); err != nil {
		return c, err
	}
	return normalizedNetworkProxy(c), nil
}

func saveNetworkProxyConfig(path string, c NetworkProxyConfig) error {
	if _, err := networkProxyURL(c); err != nil {
		return err
	}
	data, err := json.Marshal(normalizedNetworkProxy(c))
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".network-proxy-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// Parent startup seam: pass a private application settings directory, never a
// renderer-selected path. Invoke before creating WebView2; this does no UI work.
// Current/Apply retain initialization errors instead of reporting default "off".
func prepareNetworkProxyStartup(directory string) (err error) {
	if os.Getenv("MYGO_GENERATE") != "" {
		return nil
	}
	defer func() { errNetworkProxyStartup = err }()
	if directory == "" || !filepath.IsAbs(directory) {
		return errors.New("proxy settings directory must be absolute")
	}
	path := filepath.Join(directory, "network-proxy.json")
	c, err := readNetworkProxyConfig(path)
	if err != nil {
		return err
	}
	desktopNetworkProxy.mu.Lock()
	desktopNetworkProxy.config = c
	desktopNetworkProxy.mu.Unlock()
	desktopNetworkProxy.save = func(c NetworkProxyConfig) error { return saveNetworkProxyConfig(path, c) }
	return nil
}

// Call on the main thread after attaching the real main window. Does not save.
func restoreNetworkProxyWebview() (NetworkProxyReceipt, error) {
	if errNetworkProxyStartup != nil {
		return NetworkProxyReceipt{}, errNetworkProxyStartup
	}
	desktopNetworkProxy.mu.RLock()
	c := desktopNetworkProxy.config
	downloads := desktopNetworkProxy.downloads
	desktopNetworkProxy.mu.RUnlock()
	web, restart, code, err := desktopNetworkProxy.applyRoute(c)
	return NetworkProxyReceipt{GatewayApplied: web, DownloadsApplied: downloads, RestartRequired: restart, ErrorCode: code}, err
}

func configureDownloadProxyTransport(transport *http.Transport) {
	desktopNetworkProxy.configureDownloadTransport(transport)
}
