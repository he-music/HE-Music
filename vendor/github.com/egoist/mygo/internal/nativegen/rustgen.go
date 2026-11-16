package nativegen

import (
	"bytes"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// RustFile is the generated Rust of a module, a module of its crate that
// the crate's lib.rs declares (mod mygo;).
const RustFile = "mygo.rs"

// RustDir is the directory of a module's Rust sources.
func RustDir(m *Module) string { return m.Dir + "/rust/src" }

// GenerateRust writes the Rust side: the traits the implementation
// implements, the structs, enums and errors of the Go side, and the
// functions Go calls, which call the factories of the crate's root
// (make_<entry point>).
func GenerateRust(m *Module) ([]byte, error) {
	if err := portable(m, "Rust"); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	g := &rustGen{m: m, b: &b, w: newWire(m)}
	g.p("%s// %s\n//\n// The declarations of package %s, which the implementation implements,\n// and the functions Go calls. See docs/native-modules.md.\n\n", goHeader, SourceLine(m.Hash), m.Package)
	g.p("#![allow(dead_code, unused_imports, unused_variables, unused_mut, unused_parens, non_snake_case, non_camel_case_types, clippy::all)]\n\n")
	g.p("use std::collections::HashMap;\nuse std::sync::Arc;\nuse std::time::{Duration, SystemTime};\n")
	for _, it := range m.Interfaces {
		g.trait(it)
	}
	for _, s := range m.Structs {
		g.structDecl(s, m)
	}
	for _, e := range m.Enums {
		g.enumDecl(e)
	}
	g.errorsDecl()
	g.foreign()
	g.p("\n// The functions Go calls.\n")
	g.p("\n#[no_mangle]\npub unsafe extern \"C\" fn %s(cb: Callback, id_base: u64, malloc: Malloc, free: Free) {\n    let _ = RUNTIME.set(Runtime { cb, id_base, malloc, free });\n}\n", g.sym("init"))
	for _, it := range m.Interfaces {
		if it.ByGo {
			g.goProxy(it)
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
	g.p("%s", strings.ReplaceAll(rustSupport, "MODULEError", m.Name+"Error"))
	return b.Bytes(), nil
}

// portable reports what of the module the implementation in lang, which
// runs on every platform, cannot take: what only Apple's platforms have,
// and the interfaces of other modules.
func portable(m *Module, lang string) error {
	var problems []string
	var check func(t *Type, where string)
	check = func(t *Type, where string) {
		if t == nil {
			return
		}
		switch t.Kind {
		case Window, View, Texture:
			problems = append(problems, fmt.Sprintf("%s uses %s, which only Swift implements", where, t.Go))
		case InterfaceType:
			if t.Pkg != nil {
				problems = append(problems, fmt.Sprintf("%s uses %s, an interface of another native module, which only Swift implements", where, t.Go))
			}
		}
		check(t.Elem, where)
		check(t.Result, where)
		for _, p := range t.Params {
			check(p.Type, where)
		}
	}
	var noBuffer func(t *Type, where string)
	noBuffer = func(t *Type, where string) {
		if t == nil {
			return
		}
		if t.Kind == Buffer {
			problems = append(problems, fmt.Sprintf("%s returns a *native.Buffer, which only Swift implementations return: take one as a parameter", where))
		}
		noBuffer(t.Elem, where)
	}
	for _, it := range m.Interfaces {
		if it.View {
			problems = append(problems, fmt.Sprintf("%s is a view, which only Swift implements", it.Name))
		}
		for _, me := range it.Methods {
			where := it.Name + "." + me.Name
			check(me.Result, where)
			noBuffer(me.Result, where)
			for _, p := range me.Params {
				check(p.Type, where)
				if p.Type.Kind == Func {
					for _, q := range p.Type.Params {
						noBuffer(q.Type, where)
					}
				}
			}
		}
	}
	for _, s := range m.Structs {
		for _, f := range s.Fields {
			check(f.Type, s.Name+"."+f.Name)
			noBuffer(f.Type, s.Name+"."+f.Name)
		}
	}
	if len(problems) > 0 {
		slices.Sort(problems)
		return fmt.Errorf("%s/: %s", strings.ToLower(lang), strings.Join(slices.Compact(problems), "\n"+strings.ToLower(lang)+"/: "))
	}
	return nil
}

type rustGen struct {
	m *Module
	b *bytes.Buffer
	w *wire
	// stub names parameters as unused, for the stub implementation.
	stub bool
}

func (g *rustGen) p(format string, args ...any) { fmt.Fprintf(g.b, format, args...) }

func (g *rustGen) sym(name string) string { return "mygo_" + g.m.Package + "_" + name }

// snake is the snake case of a Go name: DetectLanguage → detect_language,
// URLFor → url_for.
func snake(name string) string {
	r := []rune(name)
	var b strings.Builder
	for i, c := range r {
		if unicode.IsUpper(c) {
			if i > 0 && (unicode.IsLower(r[i-1]) || unicode.IsDigit(r[i-1]) || i+1 < len(r) && unicode.IsLower(r[i+1]) && unicode.IsUpper(r[i-1])) {
				b.WriteByte('_')
			}
			b.WriteRune(unicode.ToLower(c))
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

var rustKeywords = map[string]bool{
	"as": true, "break": true, "const": true, "continue": true, "else": true, "enum": true,
	"extern": true, "false": true, "fn": true, "for": true, "if": true, "impl": true, "in": true,
	"let": true, "loop": true, "match": true, "mod": true, "move": true, "mut": true, "pub": true,
	"ref": true, "return": true, "static": true, "struct": true, "trait": true, "true": true,
	"type": true, "unsafe": true, "use": true, "where": true, "while": true, "async": true,
	"await": true, "dyn": true, "abstract": true, "become": true, "box": true, "do": true,
	"final": true, "macro": true, "override": true, "priv": true, "typeof": true, "unsized": true,
	"virtual": true, "yield": true, "try": true, "gen": true,
}

// rustIdent is the Rust name of a Go field, method or parameter.
func rustIdent(name string) string {
	s := snake(name)
	switch {
	case s == "self" || s == "super" || s == "crate":
		return s + "_"
	case rustKeywords[s]:
		return "r#" + s
	}
	return s
}

func rustDoc(doc, indent string) string { return docComment(doc, indent) }

// typ is the Rust spelling of a type.
func (g *rustGen) typ(r ref) string {
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
	case String:
		return "String"
	case Bytes:
		return "Vec<u8>"
	case Time:
		return "SystemTime"
	case Duration:
		return "Duration"
	case Slice:
		return "Vec<" + g.typ(r.elem()) + ">"
	case Map:
		return "HashMap<String, " + g.typ(r.elem()) + ">"
	case Pointer:
		return "Option<" + g.typ(r.elem()) + ">"
	case StructType, EnumType:
		if mod := r.module(); mod != g.m {
			return mod.Package + "::" + t.Name
		}
		return t.Name
	case InterfaceType:
		return "Arc<dyn " + t.Name + ">"
	case Rect:
		return "Rect"
	case Buffer:
		return "Buffer"
	case Func:
		return "Arc<dyn " + g.fnSig(r) + " + Send + Sync>"
	}
	return "()"
}

// fnSig is the Fn trait of a function type.
func (g *rustGen) fnSig(r ref) string {
	var ps []string
	for _, p := range r.t.Params {
		ps = append(ps, g.typ(ref{p.Type, r.owner}))
	}
	return "Fn(" + strings.Join(ps, ", ") + ")" + g.ret(r.t.Result, r.t.Err, r.owner)
}

// ret is the return type of a function or method: " -> T", or a Result.
func (g *rustGen) ret(t *Type, err bool, owner *Module) string {
	v := "()"
	if t != nil {
		v = g.typ(ref{t, owner})
	}
	switch {
	case err:
		return " -> Result<" + v + ", Error>"
	case t == nil:
		return ""
	}
	return " -> " + v
}

// signature is the signature of a method of a trait.
func (g *rustGen) signature(m *Method) string {
	ps := []string{"&self"}
	name := rustIdent
	if g.stub {
		name = func(s string) string { return "_" + strings.TrimPrefix(rustIdent(s), "r#") }
	}
	if m.Ctx {
		ps = append(ps, name("ctx")+": &Context")
	}
	for _, p := range m.Params {
		ps = append(ps, name(p.Name)+": "+g.typ(ref{p.Type, g.m}))
	}
	s := "fn " + rustIdent(m.Name) + "(" + strings.Join(ps, ", ") + ")"
	switch {
	case m.Close:
		return "fn close(&self) -> Result<(), Error>"
	case m.Stream == 1:
		return s + " -> Stream<" + g.typ(ref{m.Result, g.m}) + ">"
	case m.Stream == 2:
		return s + " -> Stream<Result<" + g.typ(ref{m.Result, g.m}) + ", Error>>"
	case m.Closer:
		return s + " -> Box<dyn Closer>"
	}
	return s + g.ret(m.Result, m.Err, g.m)
}

func (g *rustGen) trait(it *Interface) {
	g.p("\n%s", rustDoc(it.Doc, ""))
	if it.ByGo {
		g.p("///\n/// Go implements it: the values the methods take call Go.\n")
	}
	g.p("pub trait %s: Send + Sync {\n", it.Name)
	for _, m := range it.Methods {
		g.p("%s    %s;\n", rustDoc(m.Doc, "    "), g.signature(m))
	}
	g.p("}\n")
}

// defaultable reports whether a type has a Default.
func defaultable(r ref) bool {
	switch r.t.Kind {
	case Time, Buffer, InterfaceType, Func:
		return false
	case StructType:
		mod := r.module()
		for _, f := range mod.structNamed(r.t.Name).Fields {
			if !defaultable(ref{f.Type, mod}) {
				return false
			}
		}
	case Slice, Map:
		return true
	case Pointer:
		return true
	}
	return true
}

func comparable(r ref) bool {
	switch r.t.Kind {
	case Buffer, InterfaceType, Func:
		return false
	case Slice, Map, Pointer:
		return comparable(r.elem())
	case StructType:
		mod := r.module()
		for _, f := range mod.structNamed(r.t.Name).Fields {
			if !comparable(ref{f.Type, mod}) {
				return false
			}
		}
	}
	return true
}

func (g *rustGen) structDecl(s *Struct, mod *Module) {
	r := ref{&Type{Kind: StructType, Name: s.Name}, mod}
	derive := []string{"Debug", "Clone"}
	if comparable(r) {
		derive = append(derive, "PartialEq")
	}
	if defaultable(r) {
		derive = append(derive, "Default")
	}
	g.p("\n%s#[derive(%s)]\npub struct %s {\n", rustDoc(s.Doc, ""), strings.Join(derive, ", "), s.Name)
	for _, f := range s.Fields {
		g.p("%s    pub %s: %s,\n", rustDoc(f.Doc, "    "), rustIdent(f.Name), g.typFor(ref{f.Type, mod}))
	}
	g.p("}\n")
}

// typFor is the spelling of a type of a struct of the module mod, from
// the declarations of mod: within the module of mod's foreign types, a
// type of g.m is named as one of its own.
func (g *rustGen) typFor(r ref) string {
	if r.owner == g.m {
		return g.typ(r)
	}
	// In the module of a foreign module's types, the types of that module
	// are its own, and others are siblings.
	s := g.typ(r)
	pre := r.owner.Package + "::"
	s = strings.ReplaceAll(s, pre, "")
	return s
}

func (g *rustGen) enumDecl(e *Enum) {
	g.p("\n%s#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]\npub enum %s {\n", rustDoc(e.Doc, ""), e.Name)
	for i, c := range e.Cases {
		def := ""
		if i == 0 {
			def = "#[default]\n    "
		}
		g.p("%s    %s%s,\n", rustDoc(c.Doc, "    "), def, c.Name)
	}
	g.p("}\n")
	vt := "&'static str"
	if !e.String {
		vt = "i64"
	}
	g.p("\nimpl %s {\n    /// The value of the case in Go.\n    pub fn value(&self) -> %s {\n        match self {\n", e.Name, vt)
	for _, c := range e.Cases {
		g.p("            %s::%s => %s,\n", e.Name, c.Name, c.Value)
	}
	at := "i64"
	if e.String {
		at = "&str"
	}
	g.p("        }\n    }\n\n    /// The case of a value of Go's.\n    pub fn from_value(v: %s) -> Option<Self> {\n        match v {\n", at)
	for _, c := range e.Cases {
		g.p("            %s => Some(%s::%s),\n", c.Value, e.Name, c.Name)
	}
	g.p("            _ => None,\n        }\n    }\n}\n")
}

func (g *rustGen) errorsDecl() {
	name := g.m.Name + "Error"
	g.p("\n/// The errors package %s declares, with native.NewError, which Go\n/// compares with errors.Is. Return one as Err(%s::…into()).\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum %s {\n", g.m.Package, name, name)
	for _, e := range g.m.Errors {
		g.p("%s    %s,\n", rustDoc(e.Doc, "    "), strings.TrimPrefix(e.Name, "Err"))
	}
	g.p("}\n\nimpl %s {\n    /// The error's code, which Go knows it by.\n    pub fn code(&self) -> &'static str {\n        match *self {\n", name)
	for _, e := range g.m.Errors {
		g.p("            %s::%s => %q,\n", name, strings.TrimPrefix(e.Name, "Err"), e.Code)
	}
	g.p("        }\n    }\n\n    fn from_code(code: &str) -> Option<Self> {\n        match code {\n")
	for _, e := range g.m.Errors {
		g.p("            %q => Some(%s::%s),\n", e.Code, name, strings.TrimPrefix(e.Name, "Err"))
	}
	g.p("            _ => None,\n        }\n    }\n}\n\nimpl From<%s> for Error {\n    fn from(e: %s) -> Self { Error::Module(e) }\n}\n", name, name)
}

// foreign declares the structs and enums of other native modules that the
// module uses, in a module of each's name.
func (g *rustGen) foreign() {
	byMod := map[*Module][]ref{}
	for _, n := range g.w.names() {
		r := g.w.types[n]
		if (r.t.Kind == StructType || r.t.Kind == EnumType) && r.module() != g.m {
			byMod[r.module()] = append(byMod[r.module()], r)
		}
	}
	mods := slices.SortedFunc(maps.Keys(byMod), func(a, b *Module) int { return strings.Compare(a.Package, b.Package) })
	for _, mod := range mods {
		g.p("\n/// The types of the native module %s that %s uses.\npub mod %s {\n    use super::*;\n", mod.Package, g.m.Package, mod.Package)
		var inner bytes.Buffer
		sub := &rustGen{m: g.m, b: &inner, w: g.w}
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
		g.p("}\n")
	}
}

// read is the Rust expression reading a value of type r from the reader
// rv, a &mut Reader.
func (g *rustGen) read(r ref, rv string) string {
	t := r.t
	switch t.Kind {
	case Bool:
		return rv + ".bool()?"
	case Int:
		return rv + ".i64()? as " + g.typ(r)
	case Float:
		if t.Bits == 32 {
			return rv + ".f64()? as f32"
		}
		return rv + ".f64()?"
	case String:
		return rv + ".string()?"
	case Bytes:
		return rv + ".bytes()?"
	case Time:
		return rv + ".time()?"
	case Duration:
		return rv + ".duration()?"
	case Rect:
		return rv + ".rect()?"
	case Buffer:
		return rv + ".buffer()?"
	case InterfaceType, Func:
		return rv + ".u64()?"
	}
	return "dec_" + g.w.name(r) + "(" + rv + ")?"
}

// write is the Rust statement writing v, an expression of a &T of type
// r, to the writer wv, a &mut Writer.
func (g *rustGen) write(r ref, wv, v string) string {
	t := r.t
	switch t.Kind {
	case Bool:
		return wv + ".bool(*" + v + ");"
	case Int:
		return wv + ".i64(*" + v + " as i64);"
	case Float:
		if t.Bits == 32 {
			return wv + ".f64(*" + v + " as f64);"
		}
		return wv + ".f64(*" + v + ");"
	case String:
		return wv + ".string(" + v + ");"
	case Bytes:
		return wv + ".bytes(" + v + ");"
	case Time:
		return wv + ".time(" + v + ");"
	case Duration:
		return wv + ".duration(" + v + ");"
	case Rect:
		return wv + ".rect(" + v + ");"
	case Buffer:
		return wv + ".buffer(" + v + ");"
	case InterfaceType:
		return wv + ".u64(retain(Obj::" + t.Name + "(Arc::clone(" + v + "))));"
	}
	return "enc_" + g.w.name(r) + "(" + wv + ", " + v + ");"
}

// funcs writes the functions that encode and decode composite types.
func (g *rustGen) funcs() {
	g.p("\n// Encoding.\n")
	for _, name := range g.w.names() {
		r := g.w.types[name]
		T := g.typ(r)
		var enc, dec string
		switch r.t.Kind {
		case Slice:
			enc = fmt.Sprintf("    w.count(v.len());\n    for x in v.iter() {\n        %s\n    }", g.write(r.elem(), "w", "x"))
			dec = fmt.Sprintf("    let n = r.count()?;\n    let mut v = Vec::with_capacity(n);\n    for _ in 0..n {\n        v.push(%s);\n    }\n    Ok(v)", g.read(r.elem(), "r"))
		case Map:
			enc = fmt.Sprintf("    w.count(v.len());\n    for (k, x) in v.iter() {\n        w.string(k);\n        %s\n    }", g.write(r.elem(), "w", "x"))
			dec = fmt.Sprintf("    let n = r.count()?;\n    let mut v = HashMap::with_capacity(n);\n    for _ in 0..n {\n        let k = r.string()?;\n        v.insert(k, %s);\n    }\n    Ok(v)", g.read(r.elem(), "r"))
		case Pointer:
			enc = fmt.Sprintf("    match v {\n        Some(x) => {\n            w.bool(true);\n            %s\n        }\n        None => w.bool(false),\n    }", g.write(r.elem(), "w", "x"))
			dec = fmt.Sprintf("    if r.bool()? {\n        Ok(Some(%s))\n    } else {\n        Ok(None)\n    }", g.read(r.elem(), "r"))
		case StructType:
			mod := r.module()
			s := mod.structNamed(r.t.Name)
			if len(s.Fields) == 0 {
				enc, dec = "    w.bool(false);", "    r.bool()?;\n    Ok("+T+" {})"
				break
			}
			var es, ds []string
			for _, f := range s.Fields {
				fr := ref{f.Type, mod}
				n := rustIdent(f.Name)
				es = append(es, "    "+g.write(fr, "w", "&v."+n))
				ds = append(ds, "        "+n+": "+g.read(fr, "r")+",")
			}
			enc = strings.Join(es, "\n")
			dec = "    Ok(" + T + " {\n" + strings.Join(ds, "\n") + "\n    })"
		case EnumType:
			e := r.module().enumNamed(r.t.Name)
			if e.String {
				enc = "    w.string(v.value());"
				dec = fmt.Sprintf("    let raw = r.string()?;\n    %s::from_value(&raw).ok_or_else(|| Error::Go(format!(\"%s has no value {:?}\", raw)))", T, T)
			} else {
				enc = "    w.i64(v.value());"
				dec = fmt.Sprintf("    let raw = r.i64()?;\n    %s::from_value(raw).ok_or_else(|| Error::Go(format!(\"%s has no value {}\", raw)))", T, T)
			}
		}
		g.p("\nfn enc_%s(w: &mut Writer, v: &%s) {\n%s\n}\n", name, T, enc)
		g.p("\nfn dec_%s(r: &mut Reader) -> Result<%s, Error> {\n%s\n}\n", name, T, dec)
	}
}

// readArgs returns the statements reading a method's arguments from the
// reader _a, as _p0, _p1 …, and the expressions the implementation takes
// them as.
func (g *rustGen) readArgs(params []*Param) (stmts, vals []string) {
	if len(params) > 0 {
		stmts = append(stmts, "let _a = &mut Reader::new(args, n);")
	}
	for i, p := range params {
		v := fmt.Sprintf("_p%d", i)
		stmts = append(stmts, "let "+v+" = "+g.read(ref{p.Type, g.m}, "_a")+";")
		switch p.Type.Kind {
		case InterfaceType:
			if p.Type.Iface.ByGo {
				v = fmt.Sprintf("Arc::new(Go%s::new(%s)?) as Arc<dyn %s>", p.Type.Name, v, p.Type.Name)
			} else {
				v = fmt.Sprintf("obj_%s(%s)?", snake(p.Type.Name), v)
			}
		case Func:
			f := fmt.Sprintf("_f%d", i)
			stmts = append(stmts, "let "+f+": "+g.typ(ref{p.Type, g.m})+" = "+g.closure(v, p.Type)+";")
			v = f
		}
		vals = append(vals, v)
	}
	return stmts, vals
}

// closure is a Rust closure calling the Go function whose handle is h.
func (g *rustGen) closure(h string, t *Type) string {
	var names, body []string
	for i, p := range t.Params {
		n := fmt.Sprintf("q%d", i)
		names = append(names, n+": "+g.typ(ref{p.Type, g.m}))
		body = append(body, g.write(ref{p.Type, g.m}, "(&mut _cw)", "&"+n))
	}
	read := "|_| Ok(())"
	if t.Result != nil {
		read = "|_r| Ok(" + g.read(ref{t.Result, g.m}, "_r") + ")"
	}
	switch {
	case t.Result == nil && !t.Err:
		body = append(body, "f.notify(_cw)")
	case t.Err:
		body = append(body, "f.ask(_cw, "+read+")")
	default:
		body = append(body, "f.ask(_cw, "+read+").unwrap_or_else(|e| panic!(\"Go failed to answer: {}\", e))")
	}
	return "{\n            let f = GoFunc::new(" + h + ");\n            Arc::new(move |" + strings.Join(names, ", ") + "| {\n                let mut _cw = Writer::new();\n                " + strings.Join(body, "\n                ") + "\n            })\n        }"
}

func (g *rustGen) factory(it *Interface) {
	g.p("\n#[no_mangle]\npub unsafe extern \"C\" fn %s(obj: u64, args: *const u8, n: usize, call: u64) -> *mut u8 {\n", g.sym("new_"+it.Name))
	g.p("    run(|_w| {\n        let v: Arc<dyn %s> = crate::make_%s()?;\n        _w.u64(retain(Obj::%s(v)));\n        Ok(())\n    })\n}\n", it.Name, snake(it.Name), it.Name)
}

func (g *rustGen) entry(it *Interface, m *Method) {
	name := it.Name + "_" + m.Name
	if direct(m) {
		g.direct(it, m)
		return
	}
	g.p("\n#[no_mangle]\npub unsafe extern \"C\" fn %s(obj: u64, args: *const u8, n: usize, call: u64) -> *mut u8 {\n", g.sym(name))
	stmts, vals := g.readArgs(m.Params)
	prelude := fmt.Sprintf("        let _o = obj_%s(obj)?;\n", snake(it.Name))
	for _, s := range stmts {
		prelude += "        " + s + "\n"
	}
	args := strings.Join(vals, ", ")
	call := "_o." + rustIdent(m.Name) + "("
	if m.Ctx {
		call += "_ctx"
		if args != "" {
			call += ", "
		}
	}
	call += args + ")"
	switch {
	case m.Stream != 0:
		make := call
		if m.Stream == 1 {
			make = "Box::new(" + call + ".map(Ok))"
		}
		g.p("    start(|| {\n%s        stream(call, move |_ctx| %s, |_w, _r| { %s });\n        Ok(())\n    })\n}\n", prelude, make, g.write(ref{m.Result, g.m}, "_w", "_r"))
		return
	case m.Async():
		q := ""
		if m.Err {
			q = "?"
		}
		body := call + q + ";"
		if m.Result != nil {
			body = "let _r = " + call + q + ";\n            " + g.write(ref{m.Result, g.m}, "_w", "&_r")
		}
		g.p("    start(|| {\n%s        task(call, move |_ctx, _w| {\n            %s\n            Ok(())\n        });\n        Ok(())\n    })\n}\n", prelude, body)
		return
	}
	q := ""
	if m.Err {
		q = "?"
	}
	g.p("    run(|_w| {\n%s", prelude)
	switch {
	case m.Closer:
		g.p("        let _r = %s;\n        _w.u64(retain(Obj::Closer(Arc::from(_r))));\n", call)
	case m.Result != nil:
		g.p("        let _r = %s%s;\n        %s\n", call, q, g.write(ref{m.Result, g.m}, "_w", "&_r"))
	default:
		g.p("        %s%s;\n", call, q)
	}
	g.p("        Ok(())\n    })\n}\n")
}

// direct writes the C function of a method of numbers (see direct).
func (g *rustGen) direct(it *Interface, m *Method) {
	name := it.Name + "_" + m.Name + "_direct"
	var params, vals []string
	for i, p := range m.Params {
		v := fmt.Sprintf("_p%d", i)
		params = append(params, v+": u64")
		switch {
		case p.Type.Kind == Bool:
			v += " != 0"
		case p.Type.Kind == Float && p.Type.Bits == 32:
			v = "f64::from_bits(" + v + ") as f32"
		case p.Type.Kind == Float:
			v = "f64::from_bits(" + v + ")"
		default:
			v += " as " + g.typ(ref{p.Type, g.m})
		}
		vals = append(vals, v)
	}
	g.p("\n#[no_mangle]\npub unsafe extern \"C\" fn %s(obj: u64%s) -> u64 {\n", g.sym(name), prefixComma(params))
	call := "_o." + rustIdent(m.Name) + "(" + strings.Join(vals, ", ") + ")"
	t := m.Result
	var ret string
	switch {
	case t == nil:
		ret = call + ";\n        0"
	case t.Kind == Bool:
		ret = call + " as u64"
	case t.Kind == Float && t.Bits == 32:
		ret = "(" + call + " as f64).to_bits()"
	case t.Kind == Float:
		ret = call + ".to_bits()"
	default:
		ret = call + " as u64"
	}
	g.p("    guard(|| {\n        let _o = match obj_%s(obj) {\n            Ok(o) => o,\n            Err(_) => return 0,\n        };\n        %s\n    })\n    .unwrap_or(0)\n}\n", snake(it.Name), ret)
}

// goProxy writes the type through which the implementation calls a value
// of an interface Go implements.
func (g *rustGen) goProxy(it *Interface) {
	g.p("\n/// Calls a Go value implementing %s.\nstruct Go%s {\n    id: u64,\n}\n\nimpl Go%s {\n    fn new(id: u64) -> Result<Self, Error> {\n        if id == 0 {\n            return Err(Error::Go(\"Go passed nil for %s\".into()));\n        }\n        Ok(Go%s { id })\n    }\n}\n\nimpl Drop for Go%s {\n    fn drop(&mut self) {\n        send(KIND_RELEASE, self.id, 0, None);\n    }\n}\n", it.Name, it.Name, it.Name, it.Name, it.Name, it.Name)
	g.p("\nimpl %s for Go%s {\n", it.Name, it.Name)
	for i, m := range it.Methods {
		lines := []string{"let mut _w = Writer::new();", fmt.Sprintf("_w.i64(%d);", i)}
		for _, p := range m.Params {
			lines = append(lines, g.write(ref{p.Type, g.m}, "(&mut _w)", "&"+rustIdent(p.Name)))
		}
		read := "|_| Ok(())"
		if m.Result != nil {
			read = "|_r| Ok(" + g.read(ref{m.Result, g.m}, "_r") + ")"
		}
		var call string
		if m.Ctx {
			call = "invoke_async(self.id, ctx, _w, " + read + ")"
		} else {
			call = "invoke(self.id, _w, " + read + ")"
		}
		switch {
		case m.Err:
		case m.Result == nil && m.Ctx:
			call = "let _ = " + call + ";"
		default:
			call += ".unwrap_or_else(|e| panic!(\"Go failed to answer: {}\", e))"
		}
		lines = append(lines, call)
		g.p("    %s {\n        %s\n    }\n", g.signature(m), strings.Join(lines, "\n        "))
	}
	g.p("}\n")
}

// objects writes the objects of the implementation that Go holds, by
// their handles.
func (g *rustGen) objects() {
	g.p("\n/// An object of the implementation that Go holds, by its handle.\nenum Obj {\n")
	var closers []string
	for _, it := range g.m.Interfaces {
		if it.ByGo {
			continue
		}
		g.p("    %s(Arc<dyn %s>),\n", it.Name, it.Name)
		if it.Closer {
			closers = append(closers, it.Name)
		}
	}
	g.p("    Closer(Arc<dyn Closer>),\n}\n")
	for _, it := range g.m.Interfaces {
		if it.ByGo {
			continue
		}
		g.p("\nfn obj_%s(h: u64) -> Result<Arc<dyn %s>, Error> {\n    match object(h)? {\n        Obj::%s(o) => Ok(Arc::clone(o)),\n        _ => Err(Error::Go(\"Go passed an object that is not a %s\".into())),\n    }\n}\n", snake(it.Name), it.Name, it.Name, it.Name)
	}
	g.p("\nfn close_obj(o: &Obj) -> Result<(), Error> {\n    match o {\n")
	for _, n := range closers {
		g.p("        Obj::%s(o) => o.close(),\n", n)
	}
	g.p("        Obj::Closer(o) => o.close(),\n        _ => Ok(()),\n    }\n}\n")
}

func (g *rustGen) common() {
	g.p(`
#[no_mangle]
pub unsafe extern "C" fn %s(obj: u64, args: *const u8, n: usize, call: u64) -> *mut u8 {
    run(|_| close_obj(object(obj)?))
}

#[no_mangle]
pub unsafe extern "C" fn %s(obj: u64) {
    if obj != 0 {
        let _ = guard(|| drop(Box::from_raw(obj as *mut Obj)));
    }
}

#[no_mangle]
pub unsafe extern "C" fn %s(call: u64) {
    let _ = guard(|| cancel(call));
}

#[no_mangle]
pub unsafe extern "C" fn %s(call: u64) {
    let _ = guard(|| demand(call));
}

#[no_mangle]
pub unsafe extern "C" fn %s(cont: u64, block: *mut u8) {
    let _ = guard(|| resume(cont, block));
}
`, g.sym("close"), g.sym("release"), g.sym("cancel"), g.sym("next"), g.sym("resume"))
}

// stubRust is an implementation in Rust whose every method says it is
// unsupported, to fill in one at a time.
func stubRust(m *Module) []byte {
	var b bytes.Buffer
	g := &rustGen{m: m, b: &b, w: newWire(m), stub: true}
	for _, it := range m.Interfaces {
		if it.ByGo {
			continue
		}
		class := "Native" + it.Name
		if it.Entry {
			g.p("\npub fn make_%s() -> Result<Arc<dyn %s>, Error> {\n    Ok(Arc::new(%s))\n}\n", snake(it.Name), it.Name, class)
		}
		g.p("\nstruct %s;\n\nimpl %s for %s {\n", class, it.Name, class)
		for _, me := range it.Methods {
			var body string
			switch {
			case me.Close:
				body = "Ok(())"
			case me.Stream == 1:
				body = "stream_of(std::iter::empty())"
			case me.Stream == 2:
				body = "stream_of(std::iter::once(Err(Error::Unsupported)))"
			case me.Closer:
				body = "closer(|| {})"
			case me.Err:
				body = "Err(Error::Unsupported)"
			case me.Result == nil:
				body = ""
			default:
				body = "unimplemented!(\"" + it.Name + "." + me.Name + "\")"
			}
			g.p("    %s {\n", g.signature(me))
			if body != "" {
				g.p("        %s\n", body)
			}
			g.p("    }\n")
		}
		g.p("}\n")
	}
	// The imports the signatures use.
	body := b.String()
	uses := []string{"use mygo::*;"}
	if strings.Contains(body, "HashMap<") {
		uses = append(uses, "use std::collections::HashMap;")
	}
	uses = append(uses, "use std::sync::Arc;")
	var times []string
	for _, t := range []string{"Duration", "SystemTime"} {
		if regexp.MustCompile(`\b` + t + `\b`).MatchString(body) {
			times = append(times, t)
		}
	}
	switch len(times) {
	case 1:
		uses = append(uses, "use std::time::"+times[0]+";")
	case 2:
		uses = append(uses, "use std::time::{Duration, SystemTime};")
	}
	head := fmt.Sprintf("//! The implementation of package %s in Rust. Implement the methods one\n//! at a time: each says it is unsupported until it does.\n\nmod mygo;\n\n%s\n", m.Package, strings.Join(uses, "\n"))
	return append([]byte(head), body...)
}
