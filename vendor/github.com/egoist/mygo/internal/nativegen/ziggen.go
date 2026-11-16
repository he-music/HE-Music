package nativegen

import (
	"bytes"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// ZigFile is the generated Zig of a module, the root of its library, which
// imports the implementation from src/<package>.zig.
const ZigFile = "mygo.zig"

// GenerateZig writes the Zig side: the interfaces the implementation
// implements, as values of a pointer and a table of its methods, the
// structs, enums and errors of the Go side, and the functions Go calls,
// which call the factories of the implementation (make<Entry point>).
func GenerateZig(m *Module) ([]byte, error) {
	if err := portable(m, "Zig"); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	g := &zigGen{m: m, b: &b, w: newWire(m)}
	g.p("%s// %s\n//\n// The declarations of package %s, which the implementation in %s.zig\n// implements, and the functions Go calls. See docs/native-modules.md.\n\n", goHeader, SourceLine(m.Hash), m.Package, m.Package)
	g.p("const std = @import(\"std\");\nconst impl = @import(%q);\n\npub const Allocator = std.mem.Allocator;\n", m.Package+".zig")
	for _, it := range m.Interfaces {
		if it.ByGo {
			g.goIface(it)
		} else {
			g.iface(it)
		}
	}
	for _, s := range m.Structs {
		g.structDecl(s, m)
	}
	for _, e := range m.Enums {
		g.enumDecl(e)
	}
	g.foreign()
	g.funcTypes()
	g.errorsDecl()
	g.p("\n// The functions Go calls.\n")
	g.p("\nexport fn %s(cb: Callback, id_base: u64, malloc: Malloc, free: Free) void {\n    runtime = .{ .cb = cb, .id_base = id_base, .malloc = malloc, .free = free };\n}\n", g.sym("init"))
	for _, it := range m.Interfaces {
		if it.ByGo {
			continue
		}
		if it.Entry {
			g.factory(it)
		}
		for _, me := range it.Methods {
			if !me.Close {
				g.entry(it, me)
			}
		}
	}
	g.objects()
	g.common()
	g.funcs()
	g.p("%s", zigSupport)
	return b.Bytes(), nil
}

type zigGen struct {
	m *Module
	b *bytes.Buffer
	w *wire
}

func (g *zigGen) p(format string, args ...any) { fmt.Fprintf(g.b, format, args...) }

func (g *zigGen) sym(name string) string { return "mygo_" + g.m.Package + "_" + name }

// param is the Zig name of a parameter, which may not shadow a method of
// the struct it is in: one of the module's methods, or of what the
// generated code declares in its structs.
func (g *zigGen) param(name string) string {
	z := zigParam(name)
	switch z {
	case "deinit", "of", "keep", "release", "call", "next", "close":
		return z + "_"
	}
	for _, it := range g.m.Interfaces {
		for _, m := range it.Methods {
			if zigMethod(m.Name) == z {
				return z + "_"
			}
		}
	}
	return z
}

var zigKeywords = map[string]bool{
	"addrspace": true, "align": true, "allowzero": true, "and": true, "anyframe": true, "anytype": true,
	"asm": true, "break": true, "callconv": true, "catch": true, "comptime": true, "const": true,
	"continue": true, "defer": true, "else": true, "enum": true, "errdefer": true, "error": true,
	"export": true, "extern": true, "fn": true, "for": true, "if": true, "inline": true,
	"linksection": true, "noalias": true, "noinline": true, "nosuspend": true, "opaque": true,
	"or": true, "orelse": true, "packed": true, "pub": true, "resume": true, "return": true,
	"struct": true, "suspend": true, "switch": true, "test": true, "threadlocal": true, "try": true,
	"union": true, "unreachable": true, "var": true, "volatile": true, "while": true,
	"bool": true, "void": true, "type": true, "anyerror": true, "anyopaque": true, "usize": true,
	"isize": true, "noreturn": true, "true": true, "false": true, "null": true, "undefined": true,
	"comptime_int": true, "comptime_float": true, "f16": true, "f32": true, "f64": true, "f80": true,
	"f128": true, "c_int": true, "c_uint": true, "c_long": true, "c_ulong": true, "c_short": true,
	"c_ushort": true, "c_char": true, "c_longlong": true, "c_ulonglong": true, "c_longdouble": true,
}

var zigIntType = regexp.MustCompile(`^[iu][0-9]+$`)

// zigName escapes a Zig keyword or primitive used as a name.
func zigName(s string) string {
	if zigKeywords[s] || zigIntType.MatchString(s) {
		return "@\"" + s + "\""
	}
	return s
}

// zigField is the Zig name of a field or an enum case: snake case.
func zigField(name string) string { return zigName(snake(name)) }

// zigMethod is the Zig name of a method: lower camel case.
func zigMethod(name string) string { return zigName(lowerCamel(name)) }

// zigDecls are the declarations of the generated Zig a parameter must not
// shadow.
var zigDecls = map[string]bool{
	"allocator": true, "io": true, "fail": true, "failGo": true, "message": true, "checkMethod": true,
	"runtime": true, "writeError": true, "readError": true, "run": true, "failed": true, "pending": true,
	"send": true, "answer": true, "retain": true, "object": true, "tasks": true, "cancel": true,
	"demand": true, "start": true, "stream": true, "invoke": true, "conts": true, "nextId": true,
	"resumeCall": true, "invokeAsync": true, "bytesOf": true, "setDetail": true, "errorCode": true,
	"errorOfCode": true, "pointer": true, "arena": true, "ctx": true, "self": true, "mygo": true, "std": true, "impl": true, "o": true, "w": true, "r": true, "a": true, "h": true, "v": true,
}

// zigParam is the Zig name of a parameter.
func zigParam(name string) string {
	if zigDecls[name] || strings.HasPrefix(name, "detail_") || strings.HasPrefix(name, "kind_") || strings.HasPrefix(name, "status_") || strings.HasPrefix(name, "err_") || strings.HasPrefix(name, "enc_") || strings.HasPrefix(name, "dec_") || strings.HasPrefix(name, "obj") {
		return name + "_"
	}
	return zigName(name)
}

// typ is the Zig spelling of a type.
func (g *zigGen) typ(r ref) string {
	t := r.t
	switch t.Kind {
	case Bool:
		return "bool"
	case Int:
		if t.Unsigned {
			return fmt.Sprintf("u%d", t.Bits)
		}
		return fmt.Sprintf("i%d", t.Bits)
	case Float:
		return fmt.Sprintf("f%d", t.Bits)
	case String, Bytes:
		return "[]const u8"
	case Time:
		return "Time"
	case Duration:
		return "i64"
	case Slice:
		return "[]const " + g.typ(r.elem())
	case Map:
		return "[]const Entry(" + g.typ(r.elem()) + ")"
	case Pointer:
		return "?" + g.typ(r.elem())
	case StructType, EnumType:
		if mod := r.module(); mod != g.m {
			return mod.Package + "." + t.Name
		}
		return t.Name
	case InterfaceType:
		return t.Name
	case Rect:
		return "Rect"
	case Buffer:
		return "Buffer"
	}
	return "void"
}

// typFor is the spelling of a type of a struct of the module mod, from
// within the declarations of mod's types.
func (g *zigGen) typFor(r ref) string {
	s := g.typ(r)
	if r.owner == g.m {
		return s
	}
	return strings.ReplaceAll(s, r.owner.Package+".", "")
}

// funcType is the name of the type of a function parameter, which calls
// Go: <Interface><Method><Parameter>.
func funcType(it *Interface, m *Method, p *Param) string {
	return it.Name + m.Name + UpperCamel(p.Name)
}

// ret is the return type of a method.
func (g *zigGen) ret(m *Method) string {
	switch {
	case m.Close:
		return "Error!void"
	case m.Stream != 0:
		return "Error!Iterator(" + g.typ(ref{m.Result, g.m}) + ")"
	case m.Closer:
		return "Error!Closer"
	}
	v := "void"
	if m.Result != nil {
		v = g.typ(ref{m.Result, g.m})
	}
	if m.Err {
		return "Error!" + v
	}
	return v
}

// params are the types of the parameters of a method after its receiver,
// with their names when named.
func (g *zigGen) params(it *Interface, m *Method, named bool) []string {
	if m.Close {
		return nil
	}
	n := func(name, t string) string {
		if named {
			return name + ": " + t
		}
		return t
	}
	ps := []string{n("arena", "Allocator")}
	if m.Ctx {
		ps = append(ps, n("ctx", "*Context"))
	}
	for _, p := range m.Params {
		t := g.typ(ref{p.Type, g.m})
		if p.Type.Kind == Func {
			t = funcType(it, m, p)
		}
		ps = append(ps, n(g.param(p.Name), t))
	}
	return ps
}

func (g *zigGen) iface(it *Interface) {
	g.p("\n%s///\n/// Make one of a pointer with %s.of: its type has the methods, which take\n/// an arena, freed once the call returns, for what they allocate.\npub const %s = struct {\n    ptr: *anyopaque,\n    vtable: *const VTable,\n\n    pub const VTable = struct {\n", docComment(it.Doc, ""), it.Name, it.Name)
	for _, m := range it.Methods {
		g.p("        %s: *const fn (%s) %s,\n", zigMethod(m.Name), strings.Join(append([]string{"*anyopaque"}, g.params(it, m, false)...), ", "), g.ret(m))
	}
	g.p("        deinit: ?*const fn (*anyopaque) void,\n    };\n")
	g.p("\n    /// Makes a %s of p, a pointer to a value whose type has its methods\n    /// and may have deinit, which Go calls once it lets go of the value.\n    pub fn of(pointer: anytype) %s {\n        const T = @typeInfo(@TypeOf(pointer)).pointer.child;\n        const vt = struct {\n", it.Name, it.Name)
	for _, m := range it.Methods {
		ps := g.params(it, m, true)
		var names []string
		for _, p := range ps {
			names = append(names, p[:strings.Index(p, ": ")])
		}
		g.p("            fn vt_%s(%s) %s {\n                return @as(*T, @ptrCast(@alignCast(o))).%s(%s);\n            }\n", strings.Trim(zigMethod(m.Name), "@\""), strings.Join(append([]string{"o: *anyopaque"}, ps...), ", "), g.ret(m), zigMethod(m.Name), strings.Join(names, ", "))
	}
	g.p("            fn vt_deinit(o: *anyopaque) void {\n                if (@hasDecl(T, \"deinit\")) @as(*T, @ptrCast(@alignCast(o))).deinit();\n            }\n            const table: VTable = .{\n")
	for _, m := range it.Methods {
		g.p("                .%s = vt_%s,\n", zigMethod(m.Name), strings.Trim(zigMethod(m.Name), "@\""))
	}
	g.p("                .deinit = if (@hasDecl(T, \"deinit\")) vt_deinit else null,\n            };\n        };\n        comptime {\n")
	for _, m := range it.Methods {
		g.p("            checkMethod(T, %q, %q, fn (%s) %s);\n", it.Name, strings.Trim(zigMethod(m.Name), "@\""), strings.Join(append([]string{"*T"}, g.params(it, m, false)...), ", "), g.ret(m))
	}
	g.p("        }\n        return .{ .ptr = pointer, .vtable = &vt.table };\n    }\n")
	for _, m := range it.Methods {
		ps := g.params(it, m, true)
		var names []string
		for _, p := range ps {
			names = append(names, p[:strings.Index(p, ": ")])
		}
		g.p("\n%s    pub fn %s(%s) %s {\n        return self.vtable.%s(%s);\n    }\n", docComment(m.Doc, "    "), zigMethod(m.Name), strings.Join(append([]string{"self: " + it.Name}, ps...), ", "), g.ret(m), zigMethod(m.Name), strings.Join(append([]string{"self.ptr"}, names...), ", "))
	}
	g.p("};\n")
}

// goIface writes the type of a value of an interface Go implements, whose
// methods call Go.
func (g *zigGen) goIface(it *Interface) {
	g.p("\n%s///\n/// Go implements it. A value the implementation is given is released once\n/// the call that gives it returns, unless the implementation keeps it.\npub const %s = struct {\n    f: *GoFunc,\n\n    /// Keeps the value past the call that gave it, until release.\n    pub fn keep(self: %s) %s {\n        self.f.retain();\n        return self;\n    }\n\n    pub fn release(self: %s) void {\n        self.f.release();\n    }\n", docComment(it.Doc, ""), it.Name, it.Name, it.Name, it.Name)
	for i, m := range it.Methods {
		ps := g.params(it, m, true)
		lines := []string{"var w = Writer.init();", "defer w.deinit();", fmt.Sprintf("w.int(%d);", i)}
		for _, p := range m.Params {
			lines = append(lines, g.write(ref{p.Type, g.m}, "(&w)", g.param(p.Name)))
		}
		R := "void"
		read := "struct {\n            fn read(_: *Reader) Error!void {}\n        }.read"
		if m.Result != nil {
			R = g.typ(ref{m.Result, g.m})
			read = "struct {\n            fn read(r: *Reader) Error!" + R + " {\n                return " + g.read(ref{m.Result, g.m}, "r") + ";\n            }\n        }.read"
		}
		call := "invoke(self.f.id, arena, &w, " + R + ", " + read + ")"
		if m.Ctx {
			call = "invokeAsync(self.f.id, arena, ctx, &w, " + R + ", " + read + ")"
		}
		if m.Err {
			lines = append(lines, "return "+call+";")
		} else {
			lines = append(lines, "return "+call+" catch @panic(\"Go failed to answer\");")
		}
		g.p("\n%s    pub fn %s(%s) %s {\n        %s\n    }\n", docComment(m.Doc, "    "), zigMethod(m.Name), strings.Join(append([]string{"self: " + it.Name}, ps...), ", "), g.ret(m), strings.Join(lines, "\n        "))
	}
	g.p("};\n")
}

// funcTypes writes the types of the functions methods take, which call Go.
func (g *zigGen) funcTypes() {
	for _, it := range g.m.Interfaces {
		if it.ByGo {
			continue
		}
		for _, m := range it.Methods {
			for _, p := range m.Params {
				if p.Type.Kind == Func {
					g.funcType(funcType(it, m, p), p.Type)
				}
			}
		}
	}
}

func (g *zigGen) funcType(name string, t *Type) {
	g.p("\n/// A function of Go's. The value a method is given is released once the\n/// call returns, unless the implementation keeps it.\npub const %s = struct {\n    f: *GoFunc,\n\n    /// Keeps the function past the call that gave it, until release.\n    pub fn keep(self: %s) %s {\n        self.f.retain();\n        return self;\n    }\n\n    pub fn release(self: %s) void {\n        self.f.release();\n    }\n", name, name, name, name)
	var ps []string
	if t.Result != nil {
		ps = append(ps, "arena: Allocator")
	}
	lines := []string{"var w = Writer.init();", "defer w.deinit();"}
	for i, p := range t.Params {
		n := fmt.Sprintf("p%d", i)
		ps = append(ps, n+": "+g.typ(ref{p.Type, g.m}))
		lines = append(lines, g.write(ref{p.Type, g.m}, "(&w)", n))
	}
	R := "void"
	if t.Result != nil {
		R = g.typ(ref{t.Result, g.m})
	}
	ret := R
	switch {
	case t.Result == nil && !t.Err:
		lines = append(lines, "self.f.notify(&w);")
	default:
		read := "struct {\n            fn read(_: *Reader) Error!void {}\n        }.read"
		if t.Result != nil {
			read = "struct {\n            fn read(r: *Reader) Error!" + R + " {\n                return " + g.read(ref{t.Result, g.m}, "r") + ";\n            }\n        }.read"
		}
		arena := "arena"
		if t.Result == nil {
			arena = "std.heap.c_allocator"
		}
		call := "self.f.ask(" + arena + ", &w, " + R + ", " + read + ")"
		if t.Err {
			ret = "Error!" + R
			lines = append(lines, "return "+call+";")
		} else {
			lines = append(lines, "return "+call+" catch @panic(\"Go failed to answer\");")
		}
	}
	g.p("\n    /// Calls the function.\n    pub fn call(%s) %s {\n        %s\n    }\n};\n", strings.Join(append([]string{"self: " + name}, ps...), ", "), ret, strings.Join(lines, "\n        "))
}

func (g *zigGen) structDecl(s *Struct, mod *Module) {
	g.p("\n%spub const %s = struct {\n", docComment(s.Doc, ""), s.Name)
	for _, f := range s.Fields {
		r := ref{f.Type, mod}
		g.p("%s    %s: %s%s,\n", docComment(f.Doc, "    "), zigField(f.Name), g.typFor(r), zigDefault(r))
	}
	g.p("};\n")
}

// zigDefault is the default of a field, " = …", for the types that have
// one.
func zigDefault(r ref) string {
	switch r.t.Kind {
	case Bool:
		return " = false"
	case Int, Float, Duration:
		return " = 0"
	case String, Bytes, Slice, Map:
		return " = &.{}"
	case Pointer:
		return " = null"
	case Time, Rect:
		return " = .{}"
	}
	return ""
}

func (g *zigGen) enumDecl(e *Enum) {
	tag := ""
	if !e.String {
		tag = "(" + g.typ(ref{basics[e.Basic], g.m}) + ")"
	}
	g.p("\n%spub const %s = enum%s {\n", docComment(e.Doc, ""), e.Name, tag)
	for _, c := range e.Cases {
		if e.String {
			g.p("%s    %s,\n", docComment(c.Doc, "    "), zigField(c.Name))
		} else {
			g.p("%s    %s = %s,\n", docComment(c.Doc, "    "), zigField(c.Name), c.Value)
		}
	}
	vt := "[]const u8"
	if !e.String {
		vt = "i64"
	}
	g.p("\n    /// The value of the case in Go.\n    pub fn value(self: %s) %s {\n", e.Name, vt)
	if e.String {
		g.p("        return switch (self) {\n")
		for _, c := range e.Cases {
			g.p("            .%s => %s,\n", zigField(c.Name), c.Value)
		}
		g.p("        };\n    }\n")
	} else {
		g.p("        return @intFromEnum(self);\n    }\n")
	}
	g.p("\n    /// The case of a value of Go's.\n    pub fn fromValue(v: %s) ?%s {\n", vt, e.Name)
	for _, c := range e.Cases {
		if e.String {
			g.p("        if (std.mem.eql(u8, v, %s)) return .%s;\n", c.Value, zigField(c.Name))
		} else {
			g.p("        if (v == %s) return .%s;\n", c.Value, zigField(c.Name))
		}
	}
	g.p("        return null;\n    }\n};\n")
}

func (g *zigGen) errorsDecl() {
	var names []string
	for _, e := range g.m.Errors {
		names = append(names, strings.TrimPrefix(e.Name, "Err"))
	}
	g.p("\n/// The errors an implementation returns: those package %s declares, with\n/// native.NewError, which Go compares with errors.Is, and the others: see\n/// fail and failGo for their messages.\npub const Error = error{ %s };\n", g.m.Package, strings.Join(append(names, "Unsupported", "Closed", "Canceled", "Go", "Other", "OutOfMemory"), ", "))
	g.p("\n/// The code of an error the module declares.\nfn errorCode(e: Error) ?[]const u8 {\n    return switch (e) {\n")
	for _, e := range g.m.Errors {
		g.p("        error.%s => %q,\n", strings.TrimPrefix(e.Name, "Err"), e.Code)
	}
	g.p("        else => null,\n    };\n}\n\nfn errorOfCode(code: []const u8) ?Error {\n")
	for _, e := range g.m.Errors {
		g.p("    if (std.mem.eql(u8, code, %q)) return error.%s;\n", e.Code, strings.TrimPrefix(e.Name, "Err"))
	}
	if len(g.m.Errors) == 0 {
		g.p("    _ = code;\n")
	}
	g.p("    return null;\n}\n")
}

// foreign declares the structs and enums of other native modules that the
// module uses, in a namespace of each's name.
func (g *zigGen) foreign() {
	byMod := map[*Module][]ref{}
	for _, n := range g.w.names() {
		r := g.w.types[n]
		if (r.t.Kind == StructType || r.t.Kind == EnumType) && r.module() != g.m {
			byMod[r.module()] = append(byMod[r.module()], r)
		}
	}
	mods := slices.SortedFunc(maps.Keys(byMod), func(a, b *Module) int { return strings.Compare(a.Package, b.Package) })
	for _, mod := range mods {
		g.p("\n/// The types of the native module %s that %s uses.\npub const %s = struct {\n", mod.Package, g.m.Package, mod.Package)
		var inner bytes.Buffer
		sub := &zigGen{m: g.m, b: &inner, w: g.w}
		for _, r := range byMod[mod] {
			if r.t.Kind == StructType {
				sub.structDecl(mod.structNamed(r.t.Name), mod)
			} else {
				sub.enumDecl(mod.enumNamed(r.t.Name))
			}
		}
		for line := range strings.Lines(inner.String()) {
			if strings.TrimSpace(line) == "" {
				g.p("\n")
			} else {
				g.p("    %s", line)
			}
		}
		g.p("};\n")
	}
}

// read is the Zig expression reading a value of type r from the reader rv,
// a *Reader.
func (g *zigGen) read(r ref, rv string) string {
	t := r.t
	switch t.Kind {
	case Bool:
		return "try " + rv + ".boolean()"
	case Int:
		switch {
		case t.Bits == 64 && t.Unsigned:
			return "try " + rv + ".uint()"
		case t.Bits == 64:
			return "try " + rv + ".int()"
		case t.Unsigned:
			return "@as(" + g.typ(r) + ", @truncate(try " + rv + ".uint()))"
		}
		return "@as(" + g.typ(r) + ", @truncate(try " + rv + ".int()))"
	case Float:
		if t.Bits == 32 {
			return "@as(f32, @floatCast(try " + rv + ".float()))"
		}
		return "try " + rv + ".float()"
	case String, Bytes:
		return "try " + rv + ".string()"
	case Time:
		return "try " + rv + ".time()"
	case Duration:
		return "try " + rv + ".int()"
	case Rect:
		return "try " + rv + ".rect()"
	case Buffer:
		return "try " + rv + ".buffer()"
	case InterfaceType, Func:
		return "try " + rv + ".uint()"
	}
	return "try dec_" + g.w.name(r) + "(" + rv + ")"
}

// write is the Zig statement writing v, of type r, to the writer wv, a
// *Writer.
func (g *zigGen) write(r ref, wv, v string) string {
	t := r.t
	switch t.Kind {
	case Bool:
		return wv + ".boolean(" + v + ");"
	case Int:
		if t.Unsigned {
			return wv + ".uint(@intCast(" + v + "));"
		}
		return wv + ".int(@intCast(" + v + "));"
	case Float:
		if t.Bits == 32 {
			return wv + ".float(@floatCast(" + v + "));"
		}
		return wv + ".float(" + v + ");"
	case String, Bytes:
		return wv + ".string(" + v + ");"
	case Time:
		return wv + ".time(" + v + ");"
	case Duration:
		return wv + ".int(" + v + ");"
	case Rect:
		return wv + ".rect(" + v + ");"
	case Buffer:
		return wv + ".buffer(" + v + ");"
	case InterfaceType:
		return wv + ".uint(try retain(.{ ." + t.Name + " = " + v + " }));"
	}
	return "enc_" + g.w.name(r) + "(" + wv + ", " + v + ");"
}

// funcs writes the functions that encode and decode composite types.
func (g *zigGen) funcs() {
	g.p("\n// Encoding.\n")
	for _, name := range g.w.names() {
		r := g.w.types[name]
		T := g.typ(r)
		var enc, dec string
		switch r.t.Kind {
		case Slice:
			enc = fmt.Sprintf("    w.count(v.len);\n    for (v) |x| {\n        %s\n    }", g.write(r.elem(), "w", "x"))
			dec = fmt.Sprintf("    const v = try r.arena.alloc(%s, try r.count());\n    for (v) |*x| x.* = %s;\n    return v;", g.typ(r.elem()), g.read(r.elem(), "r"))
		case Map:
			enc = fmt.Sprintf("    w.count(v.len);\n    for (v) |e| {\n        w.string(e.key);\n        %s\n    }", g.write(r.elem(), "w", "e.value"))
			dec = fmt.Sprintf("    const v = try r.arena.alloc(Entry(%s), try r.count());\n    for (v) |*e| {\n        e.key = try r.string();\n        e.value = %s;\n    }\n    return v;", g.typ(r.elem()), g.read(r.elem(), "r"))
		case Pointer:
			enc = fmt.Sprintf("    if (v) |x| {\n        w.boolean(true);\n        %s\n    } else {\n        w.boolean(false);\n    }", g.write(r.elem(), "w", "x"))
			dec = fmt.Sprintf("    if (!try r.boolean()) return null;\n    return %s;", g.read(r.elem(), "r"))
		case StructType:
			mod := r.module()
			s := mod.structNamed(r.t.Name)
			if len(s.Fields) == 0 {
				enc, dec = "    _ = v;\n    w.boolean(false);", "    _ = try r.boolean();\n    return .{};"
				break
			}
			var es, ds []string
			for _, f := range s.Fields {
				fr := ref{f.Type, mod}
				n := zigField(f.Name)
				es = append(es, "    "+g.write(fr, "w", "v."+n))
				ds = append(ds, "        ."+n+" = "+g.read(fr, "r")+",")
			}
			enc = strings.Join(es, "\n")
			dec = "    return .{\n" + strings.Join(ds, "\n") + "\n    };"
		case EnumType:
			e := r.module().enumNamed(r.t.Name)
			if e.String {
				enc = "    w.string(v.value());"
				dec = fmt.Sprintf("    return %s.fromValue(try r.string()) orelse error.Go;", T)
			} else {
				enc = "    w.int(v.value());"
				dec = fmt.Sprintf("    return %s.fromValue(try r.int()) orelse error.Go;", T)
			}
		}
		g.p("\nfn enc_%s(w: *Writer, v: %s) void {\n%s\n}\n", name, T, enc)
		g.p("\nfn dec_%s(r: *Reader) Error!%s {\n%s\n}\n", name, T, dec)
	}
}

// readArgs returns the statements reading a method's arguments from the
// reader a, as p0, p1 …, the expressions the implementation takes them as,
// and the statements releasing them once the call returns.
func (g *zigGen) readArgs(it *Interface, m *Method) (stmts, vals, after []string) {
	for i, p := range m.Params {
		v := fmt.Sprintf("p%d", i)
		stmts = append(stmts, "const "+v+" = "+g.read(ref{p.Type, g.m}, "a")+";")
		switch p.Type.Kind {
		case InterfaceType:
			if p.Type.Iface.ByGo {
				f := fmt.Sprintf("f%d", i)
				stmts = append(stmts, "const "+f+": "+p.Type.Name+" = .{ .f = try GoFunc.new("+v+") };")
				after = append(after, f+".release();")
				v = f
			} else {
				v = "try obj" + p.Type.Name + "(" + v + ")"
			}
		case Func:
			f := fmt.Sprintf("f%d", i)
			stmts = append(stmts, "const "+f+": "+funcType(it, m, p)+" = .{ .f = try GoFunc.new("+v+") };")
			after = append(after, f+".release();")
			v = f
		}
		vals = append(vals, v)
	}
	return stmts, vals, after
}

func (g *zigGen) factory(it *Interface) {
	g.p("\nexport fn %s(obj: u64, args: ?[*]const u8, n: usize, call: u64) ?[*]u8 {\n    _ = call;\n    return run(obj, args, n, struct {\n        fn body(arena: Allocator, w: *Writer, h: u64, a: *Reader) Error!void {\n            _ = arena;\n            _ = h;\n            _ = a;\n            const v: %s = try impl.make%s();\n            w.uint(try retain(.{ .%s = v }));\n        }\n    }.body);\n}\n", g.sym("new_"+it.Name), it.Name, it.Name, it.Name)
}

func (g *zigGen) entry(it *Interface, m *Method) {
	name := it.Name + "_" + m.Name
	if direct(m) {
		g.direct(it, m)
		return
	}
	stmts, vals, after := g.readArgs(it, m)
	head := []string{"const o = try obj" + it.Name + "(h);"}
	head = append(head, stmts...)
	for _, a := range after {
		head = append(head, "defer "+a)
	}
	if len(m.Params) == 0 {
		head = append(head, "_ = a;")
	}
	args := append([]string{"arena"}, vals...)
	if m.Ctx {
		args = append([]string{"arena", "ctx"}, vals...)
	}
	call := "o." + zigMethod(m.Name) + "(" + strings.Join(args, ", ") + ")"
	g.p("\nexport fn %s(obj: u64, args: ?[*]const u8, n: usize, call: u64) ?[*]u8 {\n", g.sym(name))
	indent := "\n            "
	switch {
	case m.Stream != 0:
		E := g.typ(ref{m.Result, g.m})
		if !m.Ctx {
			head = append(head, "_ = ctx;")
		}
		g.p("    return stream(%s, call, obj, args, n, struct {\n        fn make(arena: Allocator, ctx: *Context, h: u64, a: *Reader) Error!Iterator(%s) {%s%s\n            return %s;\n        }\n    }.make, struct {\n        fn enc(w: *Writer, v: %s) void {\n            %s\n        }\n    }.enc);\n}\n", E, E, indent, strings.Join(head, indent), call, E, g.streamEnc(m.Result))
		return
	case m.Async():
		body := "_ = try " + call + ";"
		if !m.Err {
			body = "_ = " + call + ";"
		}
		if m.Result != nil {
			q := "try "
			if !m.Err {
				q = ""
			}
			body = "const r = " + q + call + ";" + indent + g.write(ref{m.Result, g.m}, "w", "r")
		} else {
			body += indent + "_ = w;"
		}
		g.p("    return start(call, obj, args, n, struct {\n        fn body(arena: Allocator, ctx: *Context, w: *Writer, h: u64, a: *Reader) Error!void {%s%s%s%s\n        }\n    }.body);\n}\n", indent, strings.Join(head, indent), indent, body)
		return
	}
	q := ""
	if m.Err {
		q = "try "
	}
	var body string
	switch {
	case m.Closer:
		body = "const r = try " + call + ";" + indent + "w.uint(try retain(.{ .Closer = r }));"
	case m.Result != nil:
		body = "const r = " + q + call + ";" + indent + g.write(ref{m.Result, g.m}, "w", "r")
	default:
		body = "_ = w;" + indent + q + call + ";"
		if !m.Err {
			body = "_ = w;" + indent + call + ";"
		}
	}
	g.p("    _ = call;\n    return run(obj, args, n, struct {\n        fn body(arena: Allocator, w: *Writer, h: u64, a: *Reader) Error!void {%s%s%s%s\n        }\n    }.body);\n}\n", indent, strings.Join(head, indent), indent, body)
}

// streamEnc is the statement writing v, a value of a stream, to w, in a
// function that returns nothing.
func (g *zigGen) streamEnc(t *Type) string {
	if t.Kind == InterfaceType {
		return "w.uint(retain(.{ ." + t.Name + " = v }) catch 0);"
	}
	return g.write(ref{t, g.m}, "w", "v")
}

// direct writes the C function of a method of numbers (see direct).
func (g *zigGen) direct(it *Interface, m *Method) {
	name := it.Name + "_" + m.Name + "_direct"
	var params, vals []string
	for i, p := range m.Params {
		v := fmt.Sprintf("p%d", i)
		params = append(params, v+": u64")
		t := p.Type
		switch {
		case t.Kind == Bool:
			v += " != 0"
		case t.Kind == Float && t.Bits == 32:
			v = "@as(f32, @floatCast(@as(f64, @bitCast(" + v + "))))"
		case t.Kind == Float:
			v = "@as(f64, @bitCast(" + v + "))"
		case t.Unsigned:
			v = "@as(" + g.typ(ref{t, g.m}) + ", @truncate(" + v + "))"
		default:
			v = "@as(" + g.typ(ref{t, g.m}) + ", @truncate(@as(i64, @bitCast(" + v + "))))"
		}
		vals = append(vals, v)
	}
	g.p("\nexport fn %s(obj: u64%s) u64 {\n    const o = obj%s(obj) catch return 0;\n    var state = std.heap.ArenaAllocator.init(allocator);\n    defer state.deinit();\n", g.sym(name), prefixComma(params), it.Name)
	call := "o." + zigMethod(m.Name) + "(" + strings.Join(append([]string{"state.allocator()"}, vals...), ", ") + ")"
	t := m.Result
	switch {
	case t == nil:
		g.p("    %s;\n    return 0;\n", call)
	case t.Kind == Bool:
		g.p("    return @intFromBool(%s);\n", call)
	case t.Kind == Float && t.Bits == 32:
		g.p("    return @bitCast(@as(f64, %s));\n", call)
	case t.Kind == Float:
		g.p("    return @bitCast(%s);\n", call)
	case t.Unsigned:
		g.p("    return @as(u64, %s);\n", call)
	default:
		g.p("    return @bitCast(@as(i64, %s));\n", call)
	}
	g.p("}\n")
}

// objects writes the objects of the implementation that Go holds, by
// their handles.
func (g *zigGen) objects() {
	g.p("\n/// An object of the implementation that Go holds, by its handle.\nconst Obj = union(enum) {\n")
	for _, it := range g.m.Interfaces {
		if !it.ByGo {
			g.p("    %s: %s,\n", it.Name, it.Name)
		}
	}
	g.p("    Closer: Closer,\n\n    fn deinit(o: Obj) void {\n        switch (o) {\n            inline else => |v| if (v.vtable.deinit) |d| d(v.ptr),\n        }\n    }\n\n    fn close(o: Obj) Error!void {\n        switch (o) {\n")
	for _, it := range g.m.Interfaces {
		if !it.ByGo && it.Closer {
			g.p("            .%s => |v| try v.close(),\n", it.Name)
		}
	}
	g.p("            .Closer => |v| try v.close(),\n            else => {},\n        }\n    }\n};\n")
	for _, it := range g.m.Interfaces {
		if it.ByGo {
			continue
		}
		g.p("\nfn obj%s(h: u64) Error!%s {\n    return switch ((try object(h)).*) {\n        .%s => |v| v,\n        else => error.Go,\n    };\n}\n", it.Name, it.Name, it.Name)
	}
}

func (g *zigGen) common() {
	g.p(`
export fn %s(obj: u64, args: ?[*]const u8, n: usize, call: u64) ?[*]u8 {
    _ = call;
    return run(obj, args, n, struct {
        fn body(arena: Allocator, w: *Writer, h: u64, a: *Reader) Error!void {
            _ = arena;
            _ = w;
            _ = a;
            try (try object(h)).close();
        }
    }.body);
}

export fn %s(obj: u64) void {
    const o = object(obj) catch return;
    o.deinit();
    allocator.destroy(o);
}

export fn %s(call: u64) void {
    cancel(call);
}

export fn %s(call: u64) void {
    demand(call);
}

export fn %s(cont: u64, block: ?[*]u8) void {
    resumeCall(cont, block);
}
`, g.sym("close"), g.sym("release"), g.sym("cancel"), g.sym("next"), g.sym("resume"))
}

// stubZig is an implementation in Zig whose every method says it is
// unsupported, to fill in one at a time.
func stubZig(m *Module) []byte {
	var b bytes.Buffer
	g := &zigGen{m: m, b: &b, w: newWire(m)}
	g.p("//! The implementation of package %s in Zig. Implement the methods one at\n//! a time: each says it is unsupported until it does.\n\nconst std = @import(\"std\");\nconst mygo = @import(\"mygo.zig\");\nconst Allocator = std.mem.Allocator;\n", m.Package)
	for _, it := range m.Interfaces {
		if it.ByGo {
			continue
		}
		class := "Native" + it.Name
		if it.Entry {
			g.p("\npub fn make%s() mygo.Error!mygo.%s {\n    const v = try mygo.allocator.create(%s);\n    v.* = .{};\n    return mygo.%s.of(v);\n}\n", it.Name, it.Name, class, it.Name)
		}
		g.p("\nconst %s = struct {\n    pub fn deinit(self: *%s) void {\n        mygo.allocator.destroy(self);\n    }\n", class, class)
		for _, me := range it.Methods {
			ps := g.params(it, me, true)
			var unused []string
			for _, p := range ps {
				unused = append(unused, "_ = "+p[:strings.Index(p, ": ")]+";")
			}
			for i := range ps {
				ps[i] = qualify(ps[i])
			}
			ret := qualify(g.ret(me))
			var body string
			switch {
			case me.Close:
				body = ""
			case me.Stream != 0, me.Closer, me.Err:
				body = "return error.Unsupported;"
			case me.Result == nil:
				body = ""
			default:
				body = "@panic(\"" + it.Name + "." + me.Name + " is not implemented\");"
			}
			g.p("\n    pub fn %s(%s) %s {\n        _ = self;\n", zigMethod(me.Name), strings.Join(append([]string{"self: *" + class}, ps...), ", "), ret)
			for _, u := range unused {
				g.p("        %s\n", u)
			}
			if body != "" {
				g.p("        %s\n", body)
			}
			g.p("    }\n")
		}
		g.p("};\n")
	}
	return b.Bytes()
}

var zigTypeName = regexp.MustCompile(`\b([A-Z][A-Za-z0-9_]*)\b`)

// qualify names the declarations of mygo.zig in a type, from the
// implementation.
func qualify(s string) string {
	return zigTypeName.ReplaceAllStringFunc(s, func(n string) string { return "mygo." + n })
}

const zigBuildTemplate = `const std = @import("std");

pub fn build(b: *std.Build) void {
    const module = b.createModule(.{
        .root_source_file = b.path("src/mygo.zig"),
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
        .link_libc = true,
    });
    b.installArtifact(b.addLibrary(.{ .name = "MODULE", .linkage = .dynamic, .root_module = module }));
}
`
