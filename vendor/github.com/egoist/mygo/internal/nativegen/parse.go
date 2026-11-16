package nativegen

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
)

const (
	nativePath = "github.com/egoist/mygo/native"
	mygoPath   = "github.com/egoist/mygo"
	uiPath     = "github.com/egoist/mygo/ui"
)

// Diag is a problem with the Go side of a module, at a line of it.
type Diag struct {
	Pos token.Position
	Msg string
}

func (d Diag) String() string {
	if d.Pos.Filename == "" {
		return d.Msg
	}
	return fmt.Sprintf("%s:%d: %s", d.Pos.Filename, d.Pos.Line, d.Msg)
}

// Errors are the problems Load found, each at its line.
type Errors []Diag

func (e Errors) Error() string {
	var b strings.Builder
	for i, d := range e {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(d.String())
	}
	return b.String()
}

// GeneratedGo is the name of the generated Go file of a package.
func GeneratedGo(pkg string) string { return pkg + "_native.go" }

// isGenerated reports whether a Go file is one nativegen wrote.
func isGenerated(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return bytes.HasPrefix(data, []byte(goHeader))
}

type loader struct {
	fset  *token.FileSet
	m     *Module
	diags Errors

	types  map[string]*ast.TypeSpec
	docs   map[string]*ast.CommentGroup // a type's doc, from its spec or decl
	direct map[string][]string          // a type's //mygo: directives
	file   map[string]*ast.File         // the file declaring a type
	consts []*ast.GenDecl
	vars   []*ast.ValueSpec
	varDoc map[*ast.ValueSpec]*ast.CommentGroup
	decls  []ast.Decl // what the hash covers
	files  []*ast.File

	loaded  map[string]*Module
	loading []string

	ifaces  map[string]*Interface
	structs map[string]*Struct
	enums   map[string]*Enum
	// building guards against structs that contain themselves.
	building map[string]bool
}

// Load reads the module in dir, and the native modules it uses. Its errors
// are Errors, one per problem, at the line of the declaration.
func Load(dir string) (*Module, error) {
	return load(dir, map[string]*Module{}, nil)
}

// load reads the module in dir; loaded are the modules read so far, by
// directory, and loading those being read, which a module that uses
// itself through others would read again.
func load(dir string, loaded map[string]*Module, loading []string) (*Module, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if m, ok := loaded[abs]; ok {
		return m, nil
	}
	if slices.Contains(loading, abs) {
		return nil, fmt.Errorf("native modules use each other in a cycle: %s", strings.Join(append(loading, abs), " → "))
	}
	l := &loader{
		loaded:   loaded,
		loading:  append(loading, abs),
		fset:     token.NewFileSet(),
		m:        &Module{Dir: abs, Imports: map[string]bool{}, Deps: map[string]*Module{}, Quals: map[string]string{}},
		types:    map[string]*ast.TypeSpec{},
		docs:     map[string]*ast.CommentGroup{},
		direct:   map[string][]string{},
		file:     map[string]*ast.File{},
		varDoc:   map[*ast.ValueSpec]*ast.CommentGroup{},
		ifaces:   map[string]*Interface{},
		structs:  map[string]*Struct{},
		enums:    map[string]*Enum{},
		building: map[string]bool{},
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	var files []*ast.File
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(abs, name)
		if isGenerated(path) {
			continue
		}
		f, err := parser.ParseFile(l.fset, path, nil, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		if l.m.Package == "" {
			l.m.Package = f.Name.Name
		} else if f.Name.Name != l.m.Package {
			continue // package main of a go:build ignore file, or the like
		}
		files = append(files, f)
		l.m.Files = append(l.m.Files, path)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("%s has no Go files: declare the module's interface there, with //mygo:native", dir)
	}
	l.m.Name = UpperCamel(l.m.Package)
	l.files = files
	for _, f := range files {
		l.collect(f)
	}
	var entriesNames []string
	for name, dirs := range l.direct {
		if slices.Contains(dirs, "native") {
			entriesNames = append(entriesNames, name)
		}
	}
	sort.Slice(entriesNames, func(i, j int) bool {
		a, b := l.pos(l.types[entriesNames[i]]), l.pos(l.types[entriesNames[j]])
		if a.Filename != b.Filename {
			return a.Filename < b.Filename
		}
		return a.Offset < b.Offset
	})
	for name, dirs := range l.direct {
		if slices.Contains(dirs, "native") {
			if _, ok := l.types[name].Type.(*ast.InterfaceType); !ok {
				l.errorf(l.types[name], "//mygo:native is for interfaces, not %s", name)
			}
		}
	}
	if len(entriesNames) == 0 {
		l.diags = append(l.diags, Diag{Msg: fmt.Sprintf("package %s has no entry point: put //mygo:native in the doc comment of an interface", l.m.Package)})
	}
	for _, name := range entriesNames {
		if it := l.iface(name, nil); it != nil {
			it.Entry = true
			it.returned = true
		}
	}
	l.errorsVars()
	for _, it := range l.m.Interfaces {
		// What the module returns, the platform implements, and it may
		// be passed back; what it only takes, Go implements.
		switch {
		case !it.returned:
			it.ByGo = true
			if it.View {
				l.errorf(l.types[it.Name], "%s is a native.View, which the platform implements: a method of the module must return it, or make it an entry point with //mygo:native", it.Name)
			}
		}
	}
	for _, it := range l.m.Interfaces {
		if it.ByGo {
			l.checkByGo(it)
		}
	}
	if len(l.diags) > 0 {
		return nil, l.diags
	}
	l.m.Hash = l.hash()
	l.loaded[abs] = l.m
	return l.m, nil
}

func (l *loader) pos(n ast.Node) token.Position {
	p := l.fset.Position(n.Pos())
	if rel, err := filepath.Rel(l.m.Dir, p.Filename); err == nil {
		p.Filename = rel
	}
	return p
}

func (l *loader) errorf(n ast.Node, format string, args ...any) {
	l.diags = append(l.diags, Diag{Pos: l.pos(n), Msg: fmt.Sprintf(format, args...)})
}

func directives(groups ...*ast.CommentGroup) []string {
	var out []string
	for _, g := range groups {
		if g == nil {
			continue
		}
		for _, c := range g.List {
			if rest, ok := strings.CutPrefix(c.Text, "//mygo:"); ok {
				out = append(out, strings.TrimSpace(rest))
			}
		}
	}
	return out
}

func docText(groups ...*ast.CommentGroup) string {
	for _, g := range groups {
		if g != nil {
			if t := strings.TrimSpace(g.Text()); t != "" {
				return t
			}
		}
	}
	return ""
}

func (l *loader) collect(f *ast.File) {
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok {
			continue
		}
		switch g.Tok {
		case token.TYPE:
			l.decls = append(l.decls, g)
			for _, s := range g.Specs {
				ts := s.(*ast.TypeSpec)
				if !ts.Name.IsExported() {
					continue
				}
				l.types[ts.Name.Name] = ts
				l.file[ts.Name.Name] = f
				if ts.Doc != nil {
					l.docs[ts.Name.Name] = ts.Doc
				} else if len(g.Specs) == 1 {
					l.docs[ts.Name.Name] = g.Doc
				}
				l.direct[ts.Name.Name] = directives(ts.Doc, g.Doc)
				for _, dir := range l.direct[ts.Name.Name] {
					if dir != "native" && dir != "mainthread" {
						l.errorf(ts, "unknown directive //mygo:%s: a module knows //mygo:native and //mygo:mainthread", dir)
					}
				}
			}
		case token.CONST:
			l.decls = append(l.decls, g)
			l.consts = append(l.consts, g)
		case token.VAR:
			for _, s := range g.Specs {
				vs := s.(*ast.ValueSpec)
				if len(vs.Values) == 1 && isCall(vs.Values[0], f, nativePath, "NewError") {
					l.decls = append(l.decls, g)
					l.vars = append(l.vars, vs)
					if vs.Doc != nil {
						l.varDoc[vs] = vs.Doc
					} else if len(g.Specs) == 1 {
						l.varDoc[vs] = g.Doc
					}
				}
			}
		}
	}
}

// importPath returns the path a file imports under name.
func importPath(f *ast.File, name string) string {
	for _, imp := range f.Imports {
		path, _ := strconv.Unquote(imp.Path.Value)
		local := path[strings.LastIndex(path, "/")+1:]
		if imp.Name != nil {
			local = imp.Name.Name
		} else if path == mygoPath {
			local = "mygo"
		}
		if local == name {
			return path
		}
	}
	return ""
}

func isCall(e ast.Expr, f *ast.File, path, name string) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && sel.Sel.Name == name && importPath(f, x.Name) == path
}

func (l *loader) errorsVars() {
	seen := map[string]bool{}
	for _, vs := range l.vars {
		call := vs.Values[0].(*ast.CallExpr)
		code := ""
		if len(call.Args) == 1 {
			if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				code, _ = strconv.Unquote(lit.Value)
			}
		}
		if code == "" || len(vs.Names) != 1 {
			l.errorf(vs, "native.NewError takes the error's code, a non-empty string literal: var ErrX = native.NewError(\"x\")")
			continue
		}
		name := vs.Names[0].Name
		if !strings.HasPrefix(name, "Err") || !ast.IsExported(name) || len(name) == 3 {
			l.errorf(vs, "name the error %s ErrSomething, as Go names errors", name)
			continue
		}
		if seen[code] {
			l.errorf(vs, "two errors have the code %q: give each its own", code)
			continue
		}
		seen[code] = true
		l.m.Errors = append(l.m.Errors, &ErrorVar{Name: name, Code: code, Doc: docText(l.varDoc[vs])})
	}
}

// iface returns the module's interface named name, reading it the first
// time. from is the method that uses it, nil for an entry point.
func (l *loader) iface(name string, from ast.Node) *Interface {
	if it, ok := l.ifaces[name]; ok {
		return it
	}
	ts := l.types[name]
	it := &Interface{Name: name, Doc: docText(l.docs[name]), Pos: l.pos(ts), MainThread: slices.Contains(l.direct[name], "mainthread")}
	l.ifaces[name] = it
	l.m.Interfaces = append(l.m.Interfaces, it)
	f := l.file[name]
	typ := ts.Type.(*ast.InterfaceType)
	if ts.TypeParams != nil {
		l.errorf(ts, "%s is generic, which no implementation can be: give it concrete types", name)
	}
	for _, fld := range typ.Methods.List {
		if len(fld.Names) == 0 {
			// Embedded.
			switch t := fld.Type.(type) {
			case *ast.SelectorExpr:
				x, _ := t.X.(*ast.Ident)
				path := ""
				if x != nil {
					path = importPath(f, x.Name)
				}
				switch {
				case path == "io" && t.Sel.Name == "Closer":
					it.Closer = true
					it.Methods = append(it.Methods, &Method{Name: "Close", Err: true, Close: true, Pos: l.pos(fld)})
				case path == nativePath && t.Sel.Name == "View":
					it.View = true
					it.MainThread = true // AppKit's views are the main thread's
				default:
					l.errorf(fld, "%s embeds %s: an interface of a module embeds only io.Closer and native.View", name, exprString(t))
				}
			default:
				l.errorf(fld, "%s embeds %s: an interface of a module embeds only io.Closer and native.View; list the methods instead", name, exprString(fld.Type))
			}
			continue
		}
		ft := fld.Type.(*ast.FuncType)
		for _, n := range fld.Names {
			if !n.IsExported() {
				l.errorf(fld, "%s.%s is unexported, which an implementation cannot see: export it", name, n.Name)
				continue
			}
			if n.Name == "Close" && isCloseSig(ft) {
				it.Closer = true
				it.Methods = append(it.Methods, &Method{Name: "Close", Err: true, Close: true, Doc: docText(fld.Doc), Pos: l.pos(fld)})
				continue
			}
			if m := l.method(it, n.Name, fld, ft, f); m != nil {
				m.MainThread = m.MainThread || it.MainThread
				it.Methods = append(it.Methods, m)
			}
		}
	}
	return it
}

func isCloseSig(ft *ast.FuncType) bool {
	if ft.Params.NumFields() != 0 || ft.Results.NumFields() != 1 {
		return false
	}
	id, ok := ft.Results.List[0].Type.(*ast.Ident)
	return ok && id.Name == "error"
}

func (l *loader) method(it *Interface, name string, fld *ast.Field, ft *ast.FuncType, f *ast.File) *Method {
	m := &Method{Name: name, Doc: docText(fld.Doc), Pos: l.pos(fld), MainThread: slices.Contains(directives(fld.Doc), "mainthread")}
	where := it.Name + "." + name
	i := 0
	for _, p := range ft.Params.List {
		names := p.Names
		if len(names) == 0 {
			names = []*ast.Ident{nil}
		}
		for _, n := range names {
			pname := fmt.Sprintf("p%d", i)
			if n != nil && n.Name != "_" {
				pname = n.Name
			}
			if n != nil && strings.HasPrefix(n.Name, "_") && n.Name != "_" {
				l.errorf(p, "%s names a parameter %s: the generated code keeps names starting with _ for its own; rename it", where, n.Name)
			}
			if isSel(p.Type, f, "context", "Context") {
				if i != 0 {
					l.errorf(p, "%s takes a context.Context after other parameters: take it first", where)
				}
				m.Ctx = true
				i++
				continue
			}
			if _, ok := p.Type.(*ast.Ellipsis); ok {
				l.errorf(p, "%s is variadic, which an implementation cannot be: take a slice", where)
				continue
			}
			t := l.typeOf(p.Type, f, where, true)
			if t == nil {
				continue
			}
			if t.Kind == InterfaceType {
				t.Iface.taken = true
			}
			m.Params = append(m.Params, &Param{Name: pname, Type: t})
			i++
		}
	}
	var results []*ast.Field
	if ft.Results != nil {
		for _, r := range ft.Results.List {
			k := max(1, len(r.Names))
			for range k {
				results = append(results, r)
			}
		}
	}
	isErr := func(e ast.Expr) bool { id, ok := e.(*ast.Ident); return ok && id.Name == "error" }
	switch len(results) {
	case 0:
	case 1:
		r := results[0]
		if isErr(r.Type) {
			m.Err = true
			break
		}
		if s, elem, ok := l.iterOf(r.Type, f, where); ok {
			m.Stream, m.Result = s, elem
			break
		}
		if isSel(r.Type, f, "io", "Closer") {
			m.Closer = true
			break
		}
		m.Result = l.typeOf(r.Type, f, where, false)
	case 2:
		if !isErr(results[1].Type) {
			l.errorf(fld, "%s returns two values, the second not an error: return a value and an error, or a struct", where)
			return nil
		}
		m.Err = true
		if _, _, ok := l.iterOf(results[0].Type, f, where); ok {
			l.errorf(fld, "%s returns an iterator and an error: return iter.Seq2[T, error], whose values carry the errors", where)
			return nil
		}
		m.Result = l.typeOf(results[0].Type, f, where, false)
	default:
		l.errorf(fld, "%s returns %d values: return a value and an error, with a struct for more", where, len(results))
		return nil
	}
	if m.Result != nil && m.Result.Kind == InterfaceType {
		m.Result.Iface.returned = true
	}
	for _, p := range m.Params {
		if p.Type.Kind == Window || p.Type.Kind == View {
			m.MainThread = true // AppKit's windows are the main thread's
		}
	}
	if m.Result != nil && m.Result.Kind == Func {
		l.errorf(fld, "%s returns a function: return an interface of the package instead", where)
	}
	if m.Stream != 0 && !m.Ctx {
		l.errorf(fld, "%s returns an iterator without taking a context.Context: take one first, which stops the stream", where)
	}
	if m.Closer && m.Ctx {
		l.errorf(fld, "%s takes a context.Context and returns an io.Closer: closing it stops what it started, so take no context", where)
	}
	return m
}

func isSel(e ast.Expr, f *ast.File, path, name string) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && sel.Sel.Name == name && importPath(f, x.Name) == path
}

// iterOf reads iter.Seq[T] and iter.Seq2[T, error].
func (l *loader) iterOf(e ast.Expr, f *ast.File, where string) (int, *Type, bool) {
	switch x := e.(type) {
	case *ast.IndexExpr:
		if isSel(x.X, f, "iter", "Seq") {
			return 1, l.typeOf(x.Index, f, where, false), true
		}
	case *ast.IndexListExpr:
		if isSel(x.X, f, "iter", "Seq2") {
			if len(x.Indices) != 2 {
				return 0, nil, false
			}
			if id, ok := x.Indices[1].(*ast.Ident); !ok || id.Name != "error" {
				l.errorf(x, "%s returns iter.Seq2[%s, %s]: a stream's second value is its error, iter.Seq2[T, error]", where, exprString(x.Indices[0]), exprString(x.Indices[1]))
				return 0, nil, true
			}
			return 2, l.typeOf(x.Indices[0], f, where, false), true
		}
	}
	return 0, nil, false
}

var basics = map[string]*Type{
	"bool":    {Kind: Bool, Go: "bool"},
	"string":  {Kind: String, Go: "string"},
	"int":     {Kind: Int, Go: "int", Bits: 64},
	"int8":    {Kind: Int, Go: "int8", Bits: 8},
	"int16":   {Kind: Int, Go: "int16", Bits: 16},
	"int32":   {Kind: Int, Go: "int32", Bits: 32},
	"int64":   {Kind: Int, Go: "int64", Bits: 64},
	"uint":    {Kind: Int, Go: "uint", Bits: 64, Unsigned: true},
	"uint8":   {Kind: Int, Go: "uint8", Bits: 8, Unsigned: true},
	"byte":    {Kind: Int, Go: "byte", Bits: 8, Unsigned: true},
	"uint16":  {Kind: Int, Go: "uint16", Bits: 16, Unsigned: true},
	"uint32":  {Kind: Int, Go: "uint32", Bits: 32, Unsigned: true},
	"uint64":  {Kind: Int, Go: "uint64", Bits: 64, Unsigned: true},
	"float32": {Kind: Float, Go: "float32", Bits: 32},
	"float64": {Kind: Float, Go: "float64", Bits: 64},
	"rune":    {Kind: Int, Go: "rune", Bits: 32},
}

// typeOf reads the type of a parameter (param), a result or a field.
func (l *loader) typeOf(e ast.Expr, f *ast.File, where string, param bool) *Type {
	switch x := e.(type) {
	case *ast.Ident:
		if b, ok := basics[x.Name]; ok {
			c := *b
			return &c
		}
		switch x.Name {
		case "error":
			l.errorf(x, "%s uses error as a value: return it last, as Go does", where)
			return nil
		case "any":
			l.errorf(x, "%s uses any, which has no type an implementation can declare: use a struct of the package", where)
			return nil
		}
		ts, ok := l.types[x.Name]
		if !ok {
			l.errorf(x, "%s uses %s, which is not an exported type of the package", where, x.Name)
			return nil
		}
		switch t := ts.Type.(type) {
		case *ast.InterfaceType:
			it := l.iface(x.Name, x)
			return &Type{Kind: InterfaceType, Go: x.Name, Name: x.Name, Iface: it}
		case *ast.StructType:
			if l.structOf(x.Name, ts, t) == nil {
				return nil
			}
			return &Type{Kind: StructType, Go: x.Name, Name: x.Name}
		case *ast.Ident:
			if b, ok := basics[t.Name]; ok && (b.Kind == String || b.Kind == Int) {
				en := l.enumOf(x.Name, ts, t.Name)
				if en == nil {
					return nil
				}
				return &Type{Kind: EnumType, Go: x.Name, Name: x.Name, Enum: en}
			}
		}
		l.errorf(x, "%s uses %s, a %s: a module takes the structs, interfaces and enums of its package (type T string, or an integer type, with constants)", where, x.Name, exprString(ts.Type))
		return nil
	case *ast.ArrayType:
		if x.Len != nil {
			l.errorf(x, "%s uses the array %s: use a slice", where, exprString(x))
			return nil
		}
		if id, ok := x.Elt.(*ast.Ident); ok && (id.Name == "byte" || id.Name == "uint8") {
			return &Type{Kind: Bytes, Go: "[]byte"}
		}
		el := l.typeOf(x.Elt, f, where, false)
		if el == nil {
			return nil
		}
		if el.Kind == InterfaceType || el.Kind == Func {
			l.errorf(x, "%s uses %s: interfaces and functions cross alone, not in slices", where, exprString(x))
			return nil
		}
		return &Type{Kind: Slice, Go: "[]" + el.Go, Elem: el}
	case *ast.MapType:
		if k, ok := x.Key.(*ast.Ident); !ok || k.Name != "string" {
			l.errorf(x, "%s uses %s: maps have string keys", where, exprString(x))
			return nil
		}
		el := l.typeOf(x.Value, f, where, false)
		if el == nil {
			return nil
		}
		if el.Kind == InterfaceType || el.Kind == Func {
			l.errorf(x, "%s uses %s: interfaces and functions cross alone, not in maps", where, exprString(x))
			return nil
		}
		return &Type{Kind: Map, Go: "map[string]" + el.Go, Elem: el}
	case *ast.StarExpr:
		if isSel(x.X, f, mygoPath, "Window") {
			l.m.Imports[mygoPath] = true
			return &Type{Kind: Window, Go: "*mygo.Window"}
		}
		if isSel(x.X, f, nativePath, "Buffer") {
			return &Type{Kind: Buffer, Go: "*native.Buffer"}
		}
		if isSel(x.X, f, nativePath, "Texture") {
			if !param {
				l.errorf(x, "%s uses *native.Texture other than as a parameter: pass the texture the implementation draws into", where)
				return nil
			}
			return &Type{Kind: Texture, Go: "*native.Texture"}
		}
		el := l.typeOf(x.X, f, where, false)
		if el == nil {
			return nil
		}
		if el.Kind == InterfaceType || el.Kind == Func || el.Kind == Pointer {
			l.errorf(x, "%s uses %s: use %s itself, which may be nil", where, exprString(x), exprString(x.X))
			return nil
		}
		return &Type{Kind: Pointer, Go: "*" + el.Go, Elem: el}
	case *ast.SelectorExpr:
		switch {
		case isSel(x, f, "time", "Time"):
			l.m.Imports["time"] = true
			return &Type{Kind: Time, Go: "time.Time"}
		case isSel(x, f, "time", "Duration"):
			l.m.Imports["time"] = true
			return &Type{Kind: Duration, Go: "time.Duration"}
		case isSel(x, f, uiPath, "Rect"):
			l.m.Imports[uiPath] = true
			return &Type{Kind: Rect, Go: "ui.Rect"}
		case isSel(x, f, nativePath, "View"):
			if !param {
				l.errorf(x, "%s uses native.View other than as a parameter: a view to anchor to", where)
				return nil
			}
			return &Type{Kind: View, Go: "native.View"}
		case isSel(x, f, "context", "Context"):
			l.errorf(x, "%s uses context.Context other than as its first parameter", where)
			return nil
		case isSel(x, f, "io", "Closer"):
			l.errorf(x, "%s takes an io.Closer: only methods return one, which stops what they started", where)
			return nil
		case isSel(x, f, mygoPath, "Window"):
			l.errorf(x, "%s uses mygo.Window: take a *mygo.Window", where)
			return nil
		}
		if t := l.foreignType(x, f, where); t != nil {
			return t
		}
		return nil
	case *ast.FuncType:
		if !param {
			l.errorf(x, "%s uses a function other than as a parameter: callbacks are parameters", where)
			return nil
		}
		return l.funcOf(x, f, where)
	case *ast.ChanType:
		l.errorf(x, "%s uses %s, which an implementation cannot use: return iter.Seq2[T, error] for a stream, or take a callback", where, exprString(x))
		return nil
	case *ast.InterfaceType:
		l.errorf(x, "%s uses %s: name the interface in the package", where, exprString(x))
		return nil
	case *ast.StructType:
		l.errorf(x, "%s uses an anonymous struct: name it in the package", where)
		return nil
	}
	l.errorf(e, "%s uses %s, which crosses to no implementation", where, exprString(e))
	return nil
}

func (l *loader) funcOf(x *ast.FuncType, f *ast.File, where string) *Type {
	t := &Type{Kind: Func, Go: exprString(x)}
	i := 0
	for _, p := range x.Params.List {
		names := p.Names
		if len(names) == 0 {
			names = []*ast.Ident{nil}
		}
		for _, n := range names {
			pt := l.typeOf(p.Type, f, where, false)
			if pt == nil {
				return nil
			}
			if pt.Kind == InterfaceType {
				l.errorf(p, "%s takes a callback with an interface parameter: pass a struct", where)
				return nil
			}
			name := fmt.Sprintf("p%d", i)
			if n != nil && n.Name != "_" {
				name = n.Name
			}
			t.Params = append(t.Params, &Param{Name: name, Type: pt})
			i++
		}
	}
	var results []ast.Expr
	if x.Results != nil {
		for _, r := range x.Results.List {
			for range max(1, len(r.Names)) {
				results = append(results, r.Type)
			}
		}
	}
	isErr := func(e ast.Expr) bool { id, ok := e.(*ast.Ident); return ok && id.Name == "error" }
	switch len(results) {
	case 0:
	case 1:
		if isErr(results[0]) {
			t.Err = true
		} else if t.Result = l.typeOf(results[0], f, where, false); t.Result == nil {
			return nil
		}
	case 2:
		if !isErr(results[1]) {
			l.errorf(x, "%s takes a callback returning two values, the second not an error", where)
			return nil
		}
		t.Err = true
		if t.Result = l.typeOf(results[0], f, where, false); t.Result == nil {
			return nil
		}
	default:
		l.errorf(x, "%s takes a callback returning %d values: return a value and an error", where, len(results))
		return nil
	}
	if t.Result != nil && (t.Result.Kind == InterfaceType || t.Result.Kind == Buffer || t.Result.Kind == Window) {
		l.errorf(x, "%s takes a callback returning %s: return values that copy", where, t.Result.Go)
		return nil
	}
	return t
}

func (l *loader) structOf(name string, ts *ast.TypeSpec, st *ast.StructType) *Struct {
	if s, ok := l.structs[name]; ok {
		return s
	}
	if l.building[name] {
		l.errorf(ts, "%s contains itself: values cross as copies, so break the cycle", name)
		return nil
	}
	l.building[name] = true
	defer delete(l.building, name)
	if ts.TypeParams != nil {
		l.errorf(ts, "%s is generic: give it concrete types", name)
		return nil
	}
	s := &Struct{Name: name, Doc: docText(l.docs[name]), Pos: l.pos(ts)}
	f := l.file[name]
	ok := true
	for _, fld := range st.Fields.List {
		if len(fld.Names) == 0 {
			l.errorf(fld, "%s embeds %s: name the field", name, exprString(fld.Type))
			ok = false
			continue
		}
		for _, n := range fld.Names {
			if !n.IsExported() {
				continue
			}
			key := n.Name
			if fld.Tag != nil {
				tag, _ := strconv.Unquote(fld.Tag.Value)
				if j, ok := reflectTag(tag, "json"); ok {
					j, _, _ = strings.Cut(j, ",")
					if j == "-" {
						continue
					}
					if j != "" {
						key = j
					}
				}
			}
			t := l.typeOf(fld.Type, f, name+"."+n.Name, false)
			if t == nil {
				ok = false
				continue
			}
			switch t.Kind {
			case InterfaceType, Func, Window, Buffer:
				l.errorf(fld, "%s.%s is a %s, which crosses alone, not in a struct", name, n.Name, t.Go)
				ok = false
				continue
			}
			s.Fields = append(s.Fields, &Field{Name: n.Name, JSON: key, Doc: docText(fld.Doc, fld.Comment), Type: t})
		}
	}
	if !ok {
		return nil
	}
	l.structs[name] = s
	l.m.Structs = append(l.m.Structs, s)
	return s
}

func reflectTag(tag, key string) (string, bool) {
	for tag != "" {
		i := 0
		for i < len(tag) && tag[i] == ' ' {
			i++
		}
		tag = tag[i:]
		i = 0
		for i < len(tag) && tag[i] > ' ' && tag[i] != ':' && tag[i] != '"' {
			i++
		}
		if i == 0 || i+1 >= len(tag) || tag[i] != ':' || tag[i+1] != '"' {
			return "", false
		}
		name := tag[:i]
		tag = tag[i+1:]
		i = 1
		for i < len(tag) && tag[i] != '"' {
			if tag[i] == '\\' {
				i++
			}
			i++
		}
		if i >= len(tag) {
			return "", false
		}
		qv := tag[:i+1]
		tag = tag[i+1:]
		if name == key {
			v, err := strconv.Unquote(qv)
			return v, err == nil
		}
	}
	return "", false
}

// enumOf reads the constants of a named string or integer type.
func (l *loader) enumOf(name string, ts *ast.TypeSpec, basic string) *Enum {
	if e, ok := l.enums[name]; ok {
		return e
	}
	en := &Enum{Name: name, Doc: docText(l.docs[name]), Pos: l.pos(ts), String: basic == "string", Basic: basic}
	for _, g := range l.consts {
		var typ ast.Expr
		var values []ast.Expr
		iota := 0
		for _, s := range g.Specs {
			vs := s.(*ast.ValueSpec)
			if vs.Type != nil || len(vs.Values) > 0 {
				typ, values = vs.Type, vs.Values
			}
			id, ok := typ.(*ast.Ident)
			if ok && id.Name == name {
				for i, n := range vs.Names {
					if n.Name == "_" || !n.IsExported() {
						continue
					}
					if i >= len(values) {
						l.errorf(vs, "%s has no value of its own: write it out", n.Name)
						continue
					}
					v, ok := constValue(values[i], iota, en.String)
					if !ok {
						l.errorf(vs, "%s's value %s is not one a module reads: write a literal, or iota", n.Name, exprString(values[i]))
						continue
					}
					doc := docText(vs.Doc, vs.Comment)
					en.Cases = append(en.Cases, &EnumCase{Name: n.Name, Value: v, Doc: doc})
				}
			}
			iota++
		}
	}
	if len(en.Cases) == 0 {
		l.errorf(ts, "%s has no constants: declare them, as const ( A %s = ... )", name, name)
		return nil
	}
	l.enums[name] = en
	l.m.Enums = append(l.m.Enums, en)
	return en
}

// constValue evaluates the few constant expressions enums use: literals,
// iota, iota + n, iota - n, n << iota, and negations.
func constValue(e ast.Expr, iota int, str bool) (string, bool) {
	if str {
		lit, ok := e.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(lit.Value)
		return strconv.Quote(s), err == nil
	}
	n, ok := intValue(e, iota)
	return strconv.FormatInt(n, 10), ok
}

func intValue(e ast.Expr, iota int) (int64, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind == token.INT {
			n, err := strconv.ParseInt(x.Value, 0, 64)
			return n, err == nil
		}
		if x.Kind == token.CHAR {
			r, _, _, err := strconv.UnquoteChar(x.Value[1:len(x.Value)-1], '\'')
			return int64(r), err == nil
		}
	case *ast.Ident:
		if x.Name == "iota" {
			return int64(iota), true
		}
	case *ast.ParenExpr:
		return intValue(x.X, iota)
	case *ast.UnaryExpr:
		if x.Op == token.SUB {
			n, ok := intValue(x.X, iota)
			return -n, ok
		}
	case *ast.BinaryExpr:
		a, ok1 := intValue(x.X, iota)
		b, ok2 := intValue(x.Y, iota)
		if !ok1 || !ok2 {
			return 0, false
		}
		switch x.Op {
		case token.ADD:
			return a + b, true
		case token.SUB:
			return a - b, true
		case token.MUL:
			return a * b, true
		case token.SHL:
			return a << b, true
		}
	}
	return 0, false
}

func exprString(e ast.Expr) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, token.NewFileSet(), e)
	return b.String()
}

// hash identifies the declarations of the package that the generated
// files depend on: its types, constants and errors, with their comments.
func (l *loader) hash() string {
	h := sha256.New()
	h.Write([]byte("mygo native " + Version + "\n"))
	cfg := printer.Config{Mode: printer.RawFormat}
	for _, d := range l.decls {
		g := d.(*ast.GenDecl)
		cfg.Fprint(h, l.fset, &printer.CommentedNode{Node: g, Comments: commentsOf(l, g)})
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// commentsOf returns the comments of a declaration, its doc included.
func commentsOf(l *loader, g *ast.GenDecl) []*ast.CommentGroup {
	var out []*ast.CommentGroup
	for _, f := range l.files {
		for _, c := range f.Comments {
			if c == g.Doc || (c.Pos() >= g.Pos() && c.End() <= g.End()) {
				out = append(out, c)
			}
		}
	}
	return out
}

// checkByGo checks the methods of an interface Go implements, which the
// platform calls: they take and return values that copy.
func (l *loader) checkByGo(it *Interface) {
	n := l.types[it.Name]
	for _, m := range it.Methods {
		where := it.Name + "." + m.Name
		switch {
		case m.Close:
			l.errorf(n, "%s is implemented by Go, as the module only takes it, and the platform does not close what Go implements: drop Close", it.Name)
		case m.Stream != 0 || m.Closer:
			l.errorf(n, "%s: Go implements %s, as the module only takes it, and its methods return values and errors, not streams or closers", where, it.Name)
		case m.Result != nil && (m.Result.Kind == InterfaceType || m.Result.Kind == Buffer || m.Result.Kind == Window):
			l.errorf(n, "%s: Go implements %s, as the module only takes it, and its methods return values that copy, not %s", where, it.Name, m.Result.Go)
		}
		for _, p := range m.Params {
			switch p.Type.Kind {
			case Func, InterfaceType, Window, Buffer, Texture:
				l.errorf(n, "%s: Go implements %s, as the module only takes it, and its methods take values that copy, not %s", where, it.Name, p.Type.Go)
			}
		}
	}
}

// foreignType reads a type of another package, which must be a native
// module: one of its structs, enums, or interfaces the platform implements.
func (l *loader) foreignType(x *ast.SelectorExpr, f *ast.File, where string) *Type {
	id, _ := x.X.(*ast.Ident)
	if id == nil {
		l.errorf(x, "%s uses %s, which crosses to no implementation", where, exprString(x))
		return nil
	}
	path := importPath(f, id.Name)
	other := func() {
		l.errorf(x, "%s uses %s, a type of another package, which crosses to no implementation: give it a struct of the package, or use a native module's", where, exprString(x))
	}
	if path == "" || !strings.Contains(strings.Split(path, "/")[0], ".") {
		other() // the standard library's
		return nil
	}
	dir, err := packageDir(l.m.Dir, path)
	if err != nil || !IsModule(dir) {
		other()
		return nil
	}
	dep, err := load(dir, l.loaded, l.loading)
	if err != nil {
		l.errorf(x, "%s uses %s, of the native module %s, which has problems: %v", where, exprString(x), path, err)
		return nil
	}
	name := x.Sel.Name
	t := &Type{Go: exprString(x), Name: name, Pkg: dep}
	switch {
	case slices.ContainsFunc(dep.Structs, func(s *Struct) bool { return s.Name == name }):
		t.Kind = StructType
	case slices.ContainsFunc(dep.Enums, func(e *Enum) bool { return e.Name == name }):
		t.Kind = EnumType
		t.Enum = dep.Enums[slices.IndexFunc(dep.Enums, func(e *Enum) bool { return e.Name == name })]
	default:
		i := slices.IndexFunc(dep.Interfaces, func(it *Interface) bool { return it.Name == name })
		if i < 0 {
			l.errorf(x, "%s uses %s, which the native module %s does not give its implementation: use its interfaces, structs and enums", where, exprString(x), path)
			return nil
		}
		if dep.Interfaces[i].ByGo {
			l.errorf(x, "%s uses %s, which Go implements for %s: declare such an interface in the module that takes it", where, exprString(x), path)
			return nil
		}
		t.Kind, t.Iface = InterfaceType, dep.Interfaces[i]
	}
	l.m.Deps[path] = dep
	l.m.Quals[path] = id.Name
	return t
}

// packageDir returns the directory of the package path, as the Go module
// of from sees it.
func packageDir(from, path string) (string, error) {
	cmd := exec.Command("go", "list", "-find", "-f", "{{.Dir}}", path)
	cmd.Dir = from
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
