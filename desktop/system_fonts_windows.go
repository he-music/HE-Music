//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

type dwriteGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

const (
	dwriteFactoryTypeShared             = 0
	dwriteInformationalStringFullName   = 16
	dwriteInformationalStringPostScript = 17
	dwriteFontStyleNormal               = 0
	dwriteFontStyleOblique              = 1
	dwriteFontStyleItalic               = 2
	dwriteFontWeightThin                = 100
	dwriteFontWeightExtraLight          = 200
	dwriteFontWeightLight               = 300
	dwriteFontWeightSemiLight           = 350
	dwriteFontWeightNormal              = 400
	dwriteFontWeightMedium              = 500
	dwriteFontWeightSemiBold            = 600
	dwriteFontWeightBold                = 700
	dwriteFontWeightExtraBold           = 800
	dwriteFontWeightBlack               = 900
	dwriteFontWeightExtraBlack          = 950
	dwriteRPCEModeChanged               = 0x80010106
)

var (
	dwriteDLL             = syscall.NewLazyDLL("dwrite.dll")
	dwriteCreateFactory   = dwriteDLL.NewProc("DWriteCreateFactory")
	windowsOle32          = syscall.NewLazyDLL("ole32.dll")
	windowsCoInitializeEx = windowsOle32.NewProc("CoInitializeEx")
	windowsCoUninitialize = windowsOle32.NewProc("CoUninitialize")
)

var dwriteFactoryIID = dwriteGUID{
	Data1: 0xb859ee5a,
	Data2: 0xd838,
	Data3: 0x4b5b,
	Data4: [8]byte{0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48},
}

func enumerateSystemFonts() ([]SystemFont, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	initialized, err := initializeWindowsCOM()
	if err != nil {
		return nil, err
	}
	if initialized {
		defer func() { _, _, _ = windowsCoUninitialize.Call() }()
	}

	var factory unsafe.Pointer
	hr, _, _ := dwriteCreateFactory.Call(
		dwriteFactoryTypeShared,
		uintptr(unsafe.Pointer(&dwriteFactoryIID)),
		uintptr(unsafe.Pointer(&factory)),
	)
	if err := dwriteHRESULT("DWriteCreateFactory", hr); err != nil {
		return nil, err
	}
	defer dwriteRelease(factory)

	var collection unsafe.Pointer
	if err := dwriteHRESULT("IDWriteFactory.GetSystemFontCollection", dwriteCall(factory, 3, uintptr(unsafe.Pointer(&collection)), 0)); err != nil {
		return nil, err
	}
	defer dwriteRelease(collection)

	familyCount := uint32(dwriteCall(collection, 3))
	if familyCount > maxSystemFontScan {
		return nil, errors.New("DirectWrite returned an invalid font family count")
	}

	collector := newSystemFontCollector()
	for familyIndex := range familyCount {
		var family unsafe.Pointer
		if err := dwriteHRESULT("IDWriteFontCollection.GetFontFamily", dwriteCall(collection, 4, uintptr(familyIndex), uintptr(unsafe.Pointer(&family)))); err != nil {
			return nil, err
		}
		familyName, err := dwriteFamilyName(family)
		if err != nil {
			dwriteRelease(family)
			return nil, err
		}
		fontCount := uint32(dwriteCall(family, 4))
		for fontIndex := range fontCount {
			var font unsafe.Pointer
			if err := dwriteHRESULT("IDWriteFontFamily.GetFont", dwriteCall(family, 5, uintptr(fontIndex), uintptr(unsafe.Pointer(&font)))); err != nil {
				dwriteRelease(family)
				return nil, err
			}
			face, err := dwriteFace(font, familyName)
			dwriteRelease(font)
			if err != nil {
				dwriteRelease(family)
				return nil, err
			}
			if !collector.collectFont(face) {
				break
			}
		}
		dwriteRelease(family)
		if collector.stopped {
			break
		}
	}
	return collector.fonts, nil
}

func initializeWindowsCOM() (bool, error) {
	hr, _, _ := windowsCoInitializeEx.Call(0, 0)
	if int32(uint32(hr)) >= 0 {
		return true, nil
	}
	if uint32(hr) == dwriteRPCEModeChanged {
		return false, nil
	}
	return false, dwriteHRESULT("CoInitializeEx", hr)
}

func dwriteFace(font unsafe.Pointer, family string) (SystemFont, error) {
	fullName, err := dwriteInformationalString(font, dwriteInformationalStringFullName)
	if err != nil {
		return SystemFont{}, err
	}
	postScriptName, err := dwriteInformationalString(font, dwriteInformationalStringPostScript)
	if err != nil {
		return SystemFont{}, err
	}
	weight := uint32(dwriteCall(font, 4))
	style := uint32(dwriteCall(font, 6))
	fontStyle := "normal"
	switch style {
	case dwriteFontStyleItalic:
		fontStyle = "italic"
	case dwriteFontStyleOblique:
		fontStyle = "oblique"
	}
	return SystemFont{
		Family:         family,
		FullName:       fullName,
		PostScriptName: postScriptName,
		Weight:         dwriteWeight(weight),
		Style:          fontStyle,
	}, nil
}

func dwriteInformationalString(font unsafe.Pointer, id uint32) (string, error) {
	var strings unsafe.Pointer
	var exists int32
	if err := dwriteHRESULT("IDWriteFont.GetInformationalStrings", dwriteCall(font, 9, uintptr(id), uintptr(unsafe.Pointer(&strings)), uintptr(unsafe.Pointer(&exists)))); err != nil {
		return "", err
	}
	if exists == 0 || strings == nil {
		return "", nil
	}
	defer dwriteRelease(strings)
	return dwriteLocalizedString(strings)
}

func dwriteLocalizedString(stringsObject unsafe.Pointer) (string, error) {
	var length uint32
	if err := dwriteHRESULT("IDWriteLocalizedStrings.GetStringLength", dwriteCall(stringsObject, 7, 0, uintptr(unsafe.Pointer(&length)))); err != nil {
		return "", err
	}
	if length == 0 || length > maxSystemFontName {
		return "", nil
	}
	buffer := make([]uint16, length+1)
	if err := dwriteHRESULT("IDWriteLocalizedStrings.GetString", dwriteCall(stringsObject, 8, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(length+1))); err != nil {
		return "", err
	}
	return syscall.UTF16ToString(buffer), nil
}

func dwriteFamilyName(family unsafe.Pointer) (string, error) {
	var names unsafe.Pointer
	if err := dwriteHRESULT("IDWriteFontFamily.GetFamilyNames", dwriteCall(family, 6, uintptr(unsafe.Pointer(&names)))); err != nil {
		return "", err
	}
	defer dwriteRelease(names)
	return dwriteLocalizedString(names)
}

func dwriteWeight(weight uint32) int {
	if weight <= dwriteFontWeightThin {
		return 100
	}
	if weight >= dwriteFontWeightExtraBlack {
		return 900
	}
	return int((weight + 50) / 100 * 100)
}

// dwriteCall forwards native pointer arguments to SyscallN. Keep their Go
// allocations alive and stable across the intermediate variadic wrapper.
//
//go:uintptrescapes
func dwriteCall(object unsafe.Pointer, index uintptr, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(object)
	method := *(*uintptr)(unsafe.Add(vtable, index*unsafe.Sizeof(uintptr(0))))
	callArgs := make([]uintptr, 1, len(args)+1)
	callArgs[0] = uintptr(object)
	callArgs = append(callArgs, args...)
	hr, _, _ := syscall.SyscallN(method, callArgs...)
	return hr
}

func dwriteRelease(object unsafe.Pointer) {
	if object != nil {
		dwriteCall(object, 2)
	}
}

func dwriteHRESULT(operation string, value uintptr) error {
	if int32(uint32(value)) >= 0 {
		return nil
	}
	return fmt.Errorf("%s failed with HRESULT 0x%08x", operation, uint32(value))
}
