package main

import (
	"syscall"
	"unsafe"
)

var preferencesResetMoveFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

func commitPreferencesResetRename(from, to string) error {
	source, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	destination, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	// MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH. Unlike directory fsync,
	// this is supported on Windows and waits for the move to reach the disk.
	result, _, callErr := preferencesResetMoveFileEx.Call(uintptr(unsafe.Pointer(source)), uintptr(unsafe.Pointer(destination)), 0x1|0x8)
	if result == 0 {
		return callErr
	}
	return nil
}
