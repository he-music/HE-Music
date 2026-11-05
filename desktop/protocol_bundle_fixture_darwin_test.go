//go:build darwin

package main

func newProtocolTestBundle(scenario string) *protocolBundleBridge {
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
	b.msg0 = protocolTestMessage0(name, objects)
	b.msg1 = protocolTestMessage1(name, objects)
	b.msgCString = func(_, _ uintptr, s string) uintptr { return text(s) }
	b.bool0 = func(_, _ uintptr) bool { return scenario != "nonfile" }
	b.bool1 = func(id, _, class uintptr) bool { return name(objects[id].class) == class }
	return b
}

func protocolTestMessage0(name func(string) uintptr, objects map[uintptr]*protocolBundleObject) func(uintptr, uintptr) uintptr {
	return func(id, sel uintptr) uintptr {
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
}

func protocolTestMessage1(name func(string) uintptr, objects map[uintptr]*protocolBundleObject) func(uintptr, uintptr, uintptr) uintptr {
	return func(id, sel, arg uintptr) uintptr {
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
}
