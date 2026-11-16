package nativegen

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// The binary encoding values cross in (see package native) is written and
// read by functions both sides generate for each composite type a module
// uses: slices, maps, pointers, structs and enums, named after the type
// (wireName), in Go _enc_<name> and _dec_<name>, in Swift
// _mygoWrite_<name> and _mygoRead_<name>.

// ref is a type as the module owner declares it, whose Pkg is relative to
// owner: a field of another module's struct names that module's types
// without one.
type ref struct {
	t     *Type
	owner *Module
}

func (r ref) elem() ref { return ref{r.t.Elem, r.owner} }

// module returns the module a struct or an enum is of.
func (r ref) module() *Module {
	if r.t.Pkg != nil {
		return r.t.Pkg
	}
	return r.owner
}

func (m *Module) structNamed(name string) *Struct {
	for _, s := range m.Structs {
		if s.Name == name {
			return s
		}
	}
	return nil
}

func (m *Module) enumNamed(name string) *Enum {
	for _, e := range m.Enums {
		if e.Name == name {
			return e
		}
	}
	return nil
}

func composite(t *Type) bool {
	switch t.Kind {
	case Slice, Map, Pointer, StructType, EnumType:
		return true
	}
	return false
}

// wire is what a module's generated code encodes: its composite types,
// and the modules it names that it does not import itself.
type wire struct {
	m     *Module
	types map[string]ref
	// extra are the modules of types the module uses through another
	// module's structs, by import path, which it imports too.
	extra map[string]*Module
}

// newWire collects the composite types the methods of m cross.
func newWire(m *Module) *wire {
	w := &wire{m: m, types: map[string]ref{}, extra: map[string]*Module{}}
	var add func(t *Type)
	add = func(t *Type) {
		if t == nil {
			return
		}
		w.add(ref{t, m})
		add(t.Result)
		for _, p := range t.Params {
			add(p.Type)
		}
	}
	for _, it := range m.Interfaces {
		for _, me := range it.Methods {
			add(me.Result)
			for _, p := range me.Params {
				add(p.Type)
			}
		}
	}
	return w
}

func (w *wire) add(r ref) {
	if !composite(r.t) {
		return
	}
	n := w.name(r)
	if _, ok := w.types[n]; ok {
		return
	}
	w.types[n] = r
	switch r.t.Kind {
	case Slice, Map, Pointer:
		w.add(r.elem())
	case StructType:
		mod := r.module()
		for _, f := range mod.structNamed(r.t.Name).Fields {
			w.add(ref{f.Type, mod})
		}
	}
}

// names returns the names of the composite types, sorted.
func (w *wire) names() []string { return slices.Sorted(maps.Keys(w.types)) }

// name is the name of a type in the functions that encode it.
func (w *wire) name(r ref) string {
	t := r.t
	switch t.Kind {
	case Slice:
		return "slice_" + w.name(r.elem())
	case Map:
		return "map_" + w.name(r.elem())
	case Pointer:
		return "ptr_" + w.name(r.elem())
	case StructType, EnumType:
		if mod := r.module(); mod != w.m {
			return mod.Name + "_" + t.Name
		}
		return t.Name
	case Bytes:
		return "bytes"
	case Time:
		return "time"
	case Duration:
		return "duration"
	case Rect:
		return "rect"
	case Buffer:
		return "buffer"
	case Texture:
		return "texture"
	}
	return t.Go
}

// qual returns the name the generated Go imports the module mod under.
func (w *wire) qual(mod *Module) string {
	for path, d := range w.m.Deps {
		if d == mod {
			return w.m.Quals[path]
		}
	}
	// A module of a module it uses.
	var find func(m *Module, seen map[*Module]bool) string
	find = func(m *Module, seen map[*Module]bool) string {
		if seen[m] {
			return ""
		}
		seen[m] = true
		for path, d := range m.Deps {
			if d == mod {
				return path
			}
			if p := find(d, seen); p != "" {
				return p
			}
		}
		return ""
	}
	if path := find(w.m, map[*Module]bool{}); path != "" {
		w.extra[path] = mod
	}
	return "_" + mod.Package
}

// goType is the Go spelling of a type in the module's generated code.
func (w *wire) goType(r ref) string {
	t := r.t
	switch t.Kind {
	case Slice:
		return "[]" + w.goType(r.elem())
	case Map:
		return "map[string]" + w.goType(r.elem())
	case Pointer:
		return "*" + w.goType(r.elem())
	case StructType, EnumType:
		if mod := r.module(); mod != w.m {
			return w.qual(mod) + "." + t.Name
		}
		return t.Name
	}
	return t.Go
}

// swiftType is the Swift spelling of a type in the module's generated
// code.
func (w *wire) swiftType(r ref) string {
	t := r.t
	switch t.Kind {
	case Slice:
		return "[" + w.swiftType(r.elem()) + "]"
	case Map:
		return "[String: " + w.swiftType(r.elem()) + "]"
	case Pointer:
		return w.swiftType(r.elem()) + "?"
	case StructType, EnumType:
		if mod := r.module(); mod != w.m {
			return mod.Name + "." + t.Name
		}
		return t.Name
	}
	return swiftType(t)
}

// goEnc is the Go statement that writes v, of type r, to the encoder _e.
func (w *wire) goEnc(r ref, v string) string {
	switch r.t.Kind {
	case Bool:
		return "_e.Bool(" + v + ")"
	case Int:
		return "_e.Int(int64(" + v + "))"
	case Float:
		return "_e.Float(float64(" + v + "))"
	case String:
		return "_e.String(" + v + ")"
	case Bytes:
		return "_e.Bytes(" + v + ")"
	case Time:
		return "_e.Time(" + v + ")"
	case Duration:
		return "_e.Duration(" + v + ")"
	case Rect:
		return fmt.Sprintf("_e.Rect(%s.X, %s.Y, %s.W, %s.H)", v, v, v, v)
	case Buffer:
		return "_e.Buffer(" + v + ")"
	case Texture:
		return "_e.Texture(" + v + ")"
	case InterfaceType, View:
		return "_e.Uint(_native.HandleOf(" + v + "))"
	case Window:
		return "_e.Uint(_native.WindowHandle(" + v + "))"
	}
	return "_enc_" + w.name(r) + "(_e, " + v + ")"
}

// goDec is the Go expression that reads a value of type r from the
// decoder _d.
func (w *wire) goDec(r ref) string {
	switch r.t.Kind {
	case Bool:
		return "_d.Bool()"
	case Int:
		return r.t.Go + "(_d.Int())"
	case Float:
		return r.t.Go + "(_d.Float())"
	case String:
		return "_d.String()"
	case Bytes:
		return "_d.Bytes()"
	case Time:
		return "_d.Time()"
	case Duration:
		return "_d.Duration()"
	case Rect:
		return "ui.Rect{X: float32(_d.Float()), Y: float32(_d.Float()), W: float32(_d.Float()), H: float32(_d.Float())}"
	case Buffer:
		return "_d.Buffer()"
	case InterfaceType, Window, View, Func, Texture:
		return "_d.Uint()"
	}
	return "_dec_" + w.name(r) + "(_d)"
}

// goFuncs writes the Go functions that encode and decode the composite
// types.
func (w *wire) goFuncs(p func(format string, args ...any)) {
	for _, name := range w.names() {
		r := w.types[name]
		T := w.goType(r)
		var enc, dec string
		switch r.t.Kind {
		case Slice:
			enc = fmt.Sprintf("_e.Len(len(_v))\nfor _, _x := range _v {\n%s\n}", w.goEnc(r.elem(), "_x"))
			dec = fmt.Sprintf("_n := _d.Len()\nif _n == 0 {\nreturn nil\n}\n_v := make(%s, _n)\nfor _i := range _v {\n_v[_i] = %s\n}\nreturn _v", T, w.goDec(r.elem()))
		case Map:
			enc = fmt.Sprintf("_e.Len(len(_v))\nfor _k, _x := range _v {\n_e.String(_k)\n%s\n}", w.goEnc(r.elem(), "_x"))
			dec = fmt.Sprintf("_n := _d.Len()\nif _n == 0 {\nreturn nil\n}\n_v := make(%s, _n)\nfor range _n {\n_k := _d.String()\n_v[_k] = %s\n}\nreturn _v", T, w.goDec(r.elem()))
		case Pointer:
			enc = fmt.Sprintf("if _v == nil {\n_e.Bool(false)\nreturn\n}\n_e.Bool(true)\n%s", w.goEnc(r.elem(), "*_v"))
			dec = fmt.Sprintf("if !_d.Bool() {\nreturn nil\n}\n_x := %s\nreturn &_x", w.goDec(r.elem()))
		case StructType:
			mod := r.module()
			s := mod.structNamed(r.t.Name)
			if len(s.Fields) == 0 {
				// Every value takes a byte at least: see Decoder.Len.
				enc, dec = "_e.Bool(false)", "_d.Bool()\nreturn "+T+"{}"
				break
			}
			var es, ds []string
			for _, f := range s.Fields {
				fr := ref{f.Type, mod}
				es = append(es, w.goEnc(fr, "_v."+f.Name))
				ds = append(ds, f.Name+": "+w.goDec(fr)+",")
			}
			enc = strings.Join(es, "\n")
			dec = "return " + T + "{\n" + strings.Join(ds, "\n") + "\n}"
		case EnumType:
			e := r.module().enumNamed(r.t.Name)
			if e.String {
				enc, dec = "_e.String(string(_v))", "return "+T+"(_d.String())"
			} else {
				enc, dec = "_e.Int(int64(_v))", "return "+T+"(_d.Int())"
			}
		}
		p("\nfunc _enc_%s(_e *_native.Encoder, _v %s) {\n%s\n}\n", name, T, enc)
		p("\nfunc _dec_%s(_d *_native.Decoder) %s {\n%s\n}\n", name, T, dec)
	}
}

// swiftRead is the Swift expression that reads a value of type r from the
// reader rv.
func (w *wire) swiftRead(r ref, rv string) string {
	switch r.t.Kind {
	case Bool:
		return "try " + rv + ".bool()"
	case Int:
		return swiftType(r.t) + "(truncatingIfNeeded: try " + rv + ".i64())"
	case Float:
		if r.t.Bits == 32 {
			return "Float(try " + rv + ".double())"
		}
		return "try " + rv + ".double()"
	case String:
		return "try " + rv + ".string()"
	case Bytes:
		return "try " + rv + ".data()"
	case Time:
		return "try " + rv + ".date()"
	case Duration:
		return "try " + rv + ".duration()"
	case Rect:
		return "try " + rv + ".rect()"
	case Buffer:
		return "try " + rv + ".buffer()"
	case Texture:
		return "try " + rv + ".texture()"
	case InterfaceType, Window, View, Func:
		return "try " + rv + ".u64()"
	}
	return "try _mygoRead_" + w.name(r) + "(&" + rv + ")"
}

// swiftWrite is the Swift statement that writes v, of type r, to the
// writer wv.
func (w *wire) swiftWrite(r ref, wv, v string) string {
	switch r.t.Kind {
	case Bool:
		return wv + ".bool(" + v + ")"
	case Int:
		return wv + ".i64(Int64(truncatingIfNeeded: " + v + "))"
	case Float:
		if r.t.Bits == 32 {
			return wv + ".double(Double(" + v + "))"
		}
		return wv + ".double(" + v + ")"
	case String:
		return wv + ".string(" + v + ")"
	case Bytes:
		return wv + ".data(" + v + ")"
	case Time:
		return wv + ".date(" + v + ")"
	case Duration:
		return wv + ".duration(" + v + ")"
	case Rect:
		return wv + ".rect(" + v + ")"
	case Buffer:
		return wv + ".buffer(" + v + ")"
	case Texture:
		return wv + ".texture(" + v + ")"
	case InterfaceType:
		return wv + ".u64(_mygoRetain(" + v + "))"
	}
	return "_mygoWrite_" + w.name(r) + "(&" + wv + ", " + v + ")"
}

// swiftFuncs writes the Swift functions that read and write the composite
// types.
func (w *wire) swiftFuncs(p func(format string, args ...any)) {
	for _, name := range w.names() {
		r := w.types[name]
		T := w.swiftType(r)
		var read, write string
		switch r.t.Kind {
		case Slice:
			read = fmt.Sprintf("    let n = try r.count()\n    var v: %s = []\n    v.reserveCapacity(n)\n    for _ in 0..<n { v.append(%s) }\n    return v", T, w.swiftRead(r.elem(), "r"))
			write = fmt.Sprintf("    w.count(v.count)\n    for x in v { %s }", w.swiftWrite(r.elem(), "w", "x"))
		case Map:
			read = fmt.Sprintf("    let n = try r.count()\n    var v: %s = [:]\n    v.reserveCapacity(n)\n    for _ in 0..<n {\n        let k = try r.string()\n        v[k] = %s\n    }\n    return v", T, w.swiftRead(r.elem(), "r"))
			write = fmt.Sprintf("    w.count(v.count)\n    for (k, x) in v {\n        w.string(k)\n        %s\n    }", w.swiftWrite(r.elem(), "w", "x"))
		case Pointer:
			read = fmt.Sprintf("    if try r.bool() { return %s }\n    return nil", w.swiftRead(r.elem(), "r"))
			write = fmt.Sprintf("    if let x = v {\n        w.bool(true)\n        %s\n    } else {\n        w.bool(false)\n    }", w.swiftWrite(r.elem(), "w", "x"))
		case StructType:
			mod := r.module()
			s := mod.structNamed(r.t.Name)
			if len(s.Fields) == 0 {
				read, write = "    _ = try r.bool()\n    return "+T+"()", "    w.bool(false)"
				break
			}
			var rs, ws []string
			for _, f := range s.Fields {
				fr := ref{f.Type, mod}
				n := swiftIdent(lowerCamel(f.Name))
				rs = append(rs, "        "+n+": "+w.swiftRead(fr, "r"))
				ws = append(ws, "    "+w.swiftWrite(fr, "w", "v."+n))
			}
			read = "    return " + T + "(\n" + strings.Join(rs, ",\n") + "\n    )"
			write = strings.Join(ws, "\n")
		case EnumType:
			e := r.module().enumNamed(r.t.Name)
			if e.String {
				read = fmt.Sprintf("    let raw = try r.string()\n    guard let v = %s(rawValue: raw) else { throw _MygoWireError.value(\"%s\", raw) }\n    return v", T, T)
				write = "    w.string(v.rawValue)"
			} else {
				raw := swiftType(basics[e.Basic])
				read = fmt.Sprintf("    let raw = %s(truncatingIfNeeded: try r.i64())\n    guard let v = %s(rawValue: raw) else { throw _MygoWireError.value(\"%s\", \"\\(raw)\") }\n    return v", raw, T, T)
				write = "    w.i64(Int64(truncatingIfNeeded: v.rawValue))"
			}
		}
		p("\nfunc _mygoRead_%s(_ r: inout _MygoReader) throws -> %s {\n%s\n}\n", name, T, read)
		p("\nfunc _mygoWrite_%s(_ w: inout _MygoWriter, _ v: %s) {\n%s\n}\n", name, T, write)
	}
}

// direct reports whether a method's arguments and result are numbers, so
// that Go calls it as a C function of them, without encoding them.
func direct(m *Method) bool {
	if m.Ctx || m.Stream != 0 || m.Closer || m.Close || m.Err || m.MainThread || len(m.Params) > 15 {
		return false
	}
	number := func(t *Type) bool { return t.Kind == Bool || t.Kind == Int || t.Kind == Float }
	for _, p := range m.Params {
		if !number(p.Type) {
			return false
		}
	}
	return m.Result == nil || number(m.Result)
}
