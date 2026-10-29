//go:build darwin

package main

import (
	"errors"
	"os"
	"testing"
)

// This models only the Foundation messages used by the production validator;
// it never loads a framework or calls Launch Services.
type protocolBundleObject struct {
	class string
	text  string
	props map[string]uintptr
	items []uintptr
}

func TestProtocolBundleBridgeValidation(t *testing.T) {
	for _, scenario := range []string{"valid", "bare", "no-id", "wrong-package", "no-app", "nonfile", "wrong-url-type", "wrong-types", "wrong-entry", "wrong-schemes", "undeclared", "ls-error"} {
		t.Run(scenario, func(t *testing.T) {
			names := map[string]uintptr{}
			objects := map[uintptr]*protocolBundleObject{}
			name := func(s string) uintptr {
				if names[s] == 0 {
					names[s] = uintptr(len(names) + 100)
				}
				return names[s]
			}
			text := func(s string) uintptr {
				id := name("text:" + s)
				objects[id] = &protocolBundleObject{class: "NSString", text: s}
				return id
			}
			objects[1] = &protocolBundleObject{class: "NSBundle", props: map[string]uintptr{"bundleURL": 2, "bundleIdentifier": text("music.test"), "CFBundlePackageType": text("APPL"), "CFBundleURLTypes": 3}}
			objects[2] = &protocolBundleObject{class: "NSURL", props: map[string]uintptr{"pathExtension": text("app")}}
			objects[3] = &protocolBundleObject{class: "NSArray", items: []uintptr{4}}
			objects[4] = &protocolBundleObject{class: "NSDictionary", props: map[string]uintptr{"CFBundleURLSchemes": 5}}
			objects[5] = &protocolBundleObject{class: "NSArray", items: []uintptr{text("orpheus"), text("kuwo")}}
			switch scenario {
			case "bare":
				objects[1].class = "NSObject"
			case "no-id":
				objects[1].props["bundleIdentifier"] = text("")
			case "wrong-package":
				objects[1].props["CFBundlePackageType"] = text("BNDL")
			case "no-app":
				objects[2].props["pathExtension"] = text("bin")
			case "wrong-url-type":
				objects[2].class = "NSString"
			case "wrong-types":
				objects[3].class = "NSString"
			case "wrong-entry":
				objects[4].class = "NSString"
			case "wrong-schemes":
				objects[5].class = "NSString"
			case "undeclared":
				objects[5].items = []uintptr{text("other")}
			}
			b := &protocolBundleBridge{class: name, selector: name}
			b.msg0 = func(id, sel uintptr) uintptr {
				if id == name("NSBundle") && sel == name("mainBundle") {
					return 1
				}
				if id == name("NSAutoreleasePool") && sel == name("alloc") || id == 6 && sel == name("init") {
					return 6
				}
				if id == 6 && sel == name("drain") {
					return 0
				}
				obj := objects[id]
				if sel == name("count") {
					return uintptr(len(obj.items))
				}
				if sel == name("length") {
					return uintptr(len(obj.text))
				}
				for key, value := range obj.props {
					if sel == name(key) {
						return value
					}
				}
				return 0
			}
			b.msgCString = func(_, _ uintptr, s string) uintptr { return text(s) }
			b.bool0 = func(_, _ uintptr) bool { return scenario != "nonfile" }
			b.bool1 = func(id, _ uintptr, class uintptr) bool { return name(objects[id].class) == class }
			b.msg1 = func(id, sel, arg uintptr) uintptr {
				obj := objects[id]
				if sel == name("objectAtIndex:") {
					return obj.items[arg]
				}
				if sel == name("caseInsensitiveCompare:") {
					if obj.text == objects[arg].text {
						return 0
					}
					return 1
				}
				return obj.props[objects[arg].text]
			}
			registrations, sdkCalls := 0, 0
			b.register = func(url uintptr, update bool) int32 {
				if url != 2 || !update {
					t.Fatal("must register the current bundle URL with update=true")
				}
				registrations++
				if scenario == "ls-error" {
					return -10811
				}
				return 0
			}
			err := b.withBundle("kuwo", func(register func() error) error {
				if err := register(); err != nil {
					return err
				}
				sdkCalls++
				return nil
			})
			if scenario == "valid" {
				if err != nil || registrations != 1 || sdkCalls != 1 {
					t.Fatalf("valid bundle: %v, %d, %d", err, registrations, sdkCalls)
				}
				return
			}
			var diagnostic interface{ ProtocolRegistrationReason() string }
			wantReason := "missing-declaration"
			wantRegistrations := 0
			if scenario == "ls-error" {
				wantReason, wantRegistrations = "bundle-registration-failed", 1
			}
			if !errors.As(err, &diagnostic) || diagnostic.ProtocolRegistrationReason() != wantReason || registrations != wantRegistrations || sdkCalls != 0 {
				t.Fatalf("invalid bundle: %v, %d, %d", err, registrations, sdkCalls)
			}
		})
	}
}

func TestNativeProtocolGenerationNoOS(t *testing.T) {
	t.Setenv("MYGO_GENERATE", "1")
	if os.Getenv("MYGO_GENERATE") == "" {
		t.Fatal("generation guard not installed")
	}
	b := newNativeProtocolBackend()
	if !errors.Is(b.RegisterURLScheme("orpheus"), errNativeProtocolUnavailable) ||
		!errors.Is(b.UnregisterURLScheme("kuwo"), errNativeProtocolUnavailable) || b.IsURLSchemeRegistered("kuwo") {
		t.Fatal("generation touched native backend")
	}
}
