package main

import (
	"context"
	"io"
	"os"
	"strings"
	"unicode"
)

// DeviceName preserves the native desktop device label used by authentication.
// It exposes a hardware model label, never the user's hostname or a file path.
func (*DesktopPlatform) DeviceName(ctx context.Context) (string, error) {
	var name string
	err := desktopLifecycle.call(ctx, true, func() error {
		name = normalizeDeviceModel(nativeDeviceModel(), nativeDeviceFallback())
		return nil
	})
	return name, err
}

func normalizeDeviceModel(model, fallback string) string {
	model = strings.TrimSpace(strings.TrimRight(model, "\x00"))
	if len(model) > 256 || strings.IndexFunc(model, unicode.IsControl) >= 0 {
		return fallback
	}
	if model == "" || model == "System Product Name" || model == "To Be Filled By O.E.M." {
		return fallback
	}
	return model
}

func readDeviceModelFile(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 257))
	if err != nil {
		return ""
	}
	return string(data)
}
