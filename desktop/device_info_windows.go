//go:build windows

package main

import (
	"encoding/binary"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func nativeDeviceModel() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	// Keep the original bounded, single read and REG_SZ-only contract.
	var data [258]byte
	size, kind, err := key.GetValue("SystemProductName", data[:])
	if err != nil || kind != registry.SZ || size%2 != 0 || size > len(data) {
		return ""
	}
	var value [129]uint16
	for i := range size / 2 {
		value[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	return windows.UTF16ToString(value[:size/2])
}
func nativeDeviceFallback() string { return "Windows PC" }
