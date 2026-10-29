//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func nativeDeviceModel() string {
	path, _ := syscall.UTF16PtrFromString(`HARDWARE\DESCRIPTION\System\BIOS`)
	var key syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, path, 0, syscall.KEY_QUERY_VALUE, &key) != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString("SystemProductName")
	var value [129]uint16
	size := uint32(len(value) * 2)
	var kind uint32
	if syscall.RegQueryValueEx(key, name, nil, &kind, (*byte)(unsafe.Pointer(&value[0])), &size) != nil || kind != syscall.REG_SZ || size%2 != 0 || size > uint32(len(value)*2) {
		return ""
	}
	return syscall.UTF16ToString(value[:size/2])
}
func nativeDeviceFallback() string { return "Windows PC" }
