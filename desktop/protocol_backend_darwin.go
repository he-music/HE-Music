//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"slices"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

func newNativeProtocolBackend() protocolBackend {
	var bridge *protocolBundleBridge
	return &nativeProtocolBackend{
		sdk:       mygo.App,
		available: func() bool { return os.Getenv("MYGO_GENERATE") == "" && mygo.App.IsReady() },
		onMain:    mygo.RunOnMain,
		withBundle: func(scheme string, fn func(func() error) error) error {
			if bridge == nil {
				var err error
				bridge, err = loadProtocolBundleBridge()
				if err != nil {
					return &protocolRegistrationError{"bundle-registration-failed", err}
				}
			}
			return bridge.withBundle(scheme, fn)
		},
	}
}

// Only scalar Objective-C signatures are used: id/SEL/NSUInteger are pointer
// sized; BOOL uses its low byte. No struct-return or variadic message ABI is used.
type protocolBundleBridge struct {
	class      func(string) uintptr
	selector   func(string) uintptr
	msg0       func(uintptr, uintptr) uintptr
	msg1       func(uintptr, uintptr, uintptr) uintptr
	msgCString func(uintptr, uintptr, string) uintptr
	bool0      func(uintptr, uintptr) bool
	bool1      func(uintptr, uintptr, uintptr) bool
	// Public LSRegisterURL(CFURLRef, Boolean) -> OSStatus (signed 32 bit).
	// NSURL and CFURLRef are toll-free bridged; bundleURL remains alive in pool.
	register func(uintptr, bool) int32
}

func loadProtocolBundleBridge() (*protocolBundleBridge, error) {
	b := &protocolBundleBridge{}
	var handles []uintptr
	keep := false
	defer func() {
		if !keep {
			for _, handle := range slices.Backward(handles) {
				_ = purego.Dlclose(handle)
			}
		}
	}()
	for _, path := range []string{
		"/System/Library/Frameworks/Foundation.framework/Foundation",
		"/System/Library/Frameworks/CoreServices.framework/CoreServices",
		"/usr/lib/libobjc.A.dylib",
	} {
		h, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			return nil, fmt.Errorf("load protocol framework: %w", err)
		}
		handles = append(handles, h)
	}
	for _, binding := range []struct {
		target any
		lib    uintptr
		name   string
	}{
		{&b.class, handles[2], "objc_getClass"},
		{&b.selector, handles[2], "sel_registerName"},
		{&b.msg0, handles[2], "objc_msgSend"},
		{&b.msg1, handles[2], "objc_msgSend"},
		{&b.msgCString, handles[2], "objc_msgSend"},
		{&b.bool0, handles[2], "objc_msgSend"},
		{&b.bool1, handles[2], "objc_msgSend"},
		{&b.register, handles[1], "LSRegisterURL"},
	} {
		symbol, err := purego.Dlsym(binding.lib, binding.name)
		if err != nil {
			return nil, fmt.Errorf("load protocol symbol %s: %w", binding.name, err)
		}
		purego.RegisterFunc(binding.target, symbol)
	}
	keep = true // One process-lifetime bridge, never one per scheme or attempt.
	return b, nil
}

func (b *protocolBundleBridge) send(obj uintptr, selector string) uintptr {
	return b.msg0(obj, b.selector(selector))
}

func (b *protocolBundleBridge) string(s string) uintptr {
	return b.msgCString(b.class("NSString"), b.selector("stringWithUTF8String:"), s)
}

func (b *protocolBundleBridge) kind(obj uintptr, class string) bool {
	return obj != 0 && b.bool1(obj, b.selector("isKindOfClass:"), b.class(class))
}

func (b *protocolBundleBridge) equal(obj uintptr, s string) bool {
	return b.kind(obj, "NSString") && b.msg1(obj, b.selector("caseInsensitiveCompare:"), b.string(s)) == 0
}

func (b *protocolBundleBridge) info(bundle uintptr, key string) uintptr {
	return b.msg1(bundle, b.selector("objectForInfoDictionaryKey:"), b.string(key))
}

func (b *protocolBundleBridge) withBundle(scheme string, fn func(func() error) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := b.send(b.send(b.class("NSAutoreleasePool"), "alloc"), "init")
	defer b.send(pool, "drain")
	missing := func() error {
		return &protocolRegistrationError{"missing-declaration", errors.New("current app bundle must declare the selected URL scheme, bundle identifier and APPL package type")}
	}
	bundle := b.send(b.class("NSBundle"), "mainBundle")
	if !b.kind(bundle, "NSBundle") {
		return missing()
	}
	url := b.send(bundle, "bundleURL")
	id := b.send(bundle, "bundleIdentifier")
	if !b.kind(url, "NSURL") || !b.bool0(url, b.selector("isFileURL")) ||
		!b.equal(b.send(url, "pathExtension"), "app") ||
		!b.kind(id, "NSString") || b.send(id, "length") == 0 ||
		!b.equal(b.info(bundle, "CFBundlePackageType"), "APPL") {
		return missing()
	}
	types := b.info(bundle, "CFBundleURLTypes")
	if !b.kind(types, "NSArray") {
		return missing()
	}
	declared := false
	for i, count := uintptr(0), b.send(types, "count"); i < count && !declared; i++ {
		entry := b.msg1(types, b.selector("objectAtIndex:"), i)
		if !b.kind(entry, "NSDictionary") {
			continue
		}
		schemes := b.msg1(entry, b.selector("objectForKey:"), b.string("CFBundleURLSchemes"))
		if !b.kind(schemes, "NSArray") {
			continue
		}
		for j, count := uintptr(0), b.send(schemes, "count"); j < count; j++ {
			if b.equal(b.msg1(schemes, b.selector("objectAtIndex:"), j), scheme) {
				declared = true
				break
			}
		}
	}
	if !declared {
		return missing()
	}
	return fn(func() error {
		if status := b.register(url, true); status != 0 {
			return &protocolRegistrationError{"bundle-registration-failed", fmt.Errorf("LSRegisterURL failed (OSStatus %d)", status)}
		}
		return nil
	})
}
