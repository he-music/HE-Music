package main

import "golang.org/x/sys/windows"

func openMpvLibrary(path string) (uintptr, error) {
	// 依赖 DLL 仅搜索随包目录与 System32，禁止 PATH、当前目录和用户安装目录。
	handle, err := windows.LoadLibraryEx(path, 0, windows.LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|windows.LOAD_LIBRARY_SEARCH_SYSTEM32)
	return uintptr(handle), err
}

func closeMpvLibrary(handle uintptr) { _ = windows.FreeLibrary(windows.Handle(handle)) }
