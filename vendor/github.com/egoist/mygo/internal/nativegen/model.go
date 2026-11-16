// Package nativegen reads the Go side of a native module, an interface
// that a platform's own language implements, and writes what each side
// needs from it: the Go constructors and proxies (<package>_native.go),
// and for Apple's platforms the Swift protocols, types and the @_cdecl
// functions Go calls (<Module>.mygo.swift). See docs/native-modules.md.
package nativegen

import (
	"go/token"
	"strings"
	"unicode"
)

// Version changes when the generated code changes for the same interface,
// so that `mygo build` regenerates what an older generator wrote.
const Version = "2"

// Module is the Go package of a native module.
type Module struct {
	Dir     string // the package's directory
	Package string // the Go package name: language
	Name    string // the Swift module: Language
	// Files are the package's own Go files, without the generated one.
	Files []string
	// Hash identifies the declarations the generated files came from.
	Hash string

	Interfaces []*Interface
	Structs    []*Struct
	Enums      []*Enum
	Errors     []*ErrorVar

	// Imports are the packages the generated Go imports, besides native.
	Imports map[string]bool
	// Deps are the other native modules whose types the module uses, by
	// the paths it imports them at, and Quals the names it imports them
	// under.
	Deps  map[string]*Module
	Quals map[string]string
}

// Interface is an interface of the module.
type Interface struct {
	Name       string
	Doc        string
	Pos        token.Position
	Entry      bool // //mygo:native: the package gets NewName
	MainThread bool // //mygo:mainthread: every method runs on the main thread
	View       bool // embeds native.View
	Closer     bool // embeds io.Closer or has Close() error
	// ByGo is set for an interface that methods only take: Go implements
	// it, and the platform calls it.
	ByGo     bool
	Methods  []*Method
	returned bool // a method of the module returns it
	taken    bool // a method of the module takes it
}

// Method is a method of an interface.
type Method struct {
	Name       string
	Doc        string
	Pos        token.Position
	Ctx        bool // takes a context.Context first
	MainThread bool
	Params     []*Param
	// Result is the value it returns, nil for none. For a stream it is
	// the element.
	Result *Type
	Err    bool // returns an error, last
	Stream int  // 1: iter.Seq[Result]; 2: iter.Seq2[Result, error]
	Closer bool // returns an io.Closer
	// Close is the Close() error of an interface that is closed.
	Close bool
}

// Async reports whether the method is asynchronous on the platform's side.
func (m *Method) Async() bool { return m.Ctx && m.Stream == 0 }

// Param is a parameter of a method or a callback.
type Param struct {
	Name string
	Type *Type
}

// Kind is the kind of a type that crosses between Go and the platform.
type Kind int

const (
	Bool Kind = iota
	Int
	Float
	String
	Bytes
	Time
	Duration
	Slice
	Map
	Pointer
	StructType
	EnumType
	InterfaceType
	Func
	Window
	Rect
	View
	Buffer
	Texture
	Closer
)

// Type is a type of a parameter, a result or a field.
type Type struct {
	Kind Kind
	// Go is the Go spelling: int64, []string, *Token.
	Go string
	// Bits and Unsigned describe Int and Float.
	Bits     int
	Unsigned bool
	Elem     *Type      // Slice, Map, Pointer
	Name     string     // StructType, EnumType, InterfaceType
	Iface    *Interface // InterfaceType
	Enum     *Enum      // EnumType
	// Pkg is the other native module a StructType, EnumType or
	// InterfaceType is of, nil for the module's own.
	Pkg *Module
	// Func's parameters and results.
	Params []*Param
	Result *Type
	Err    bool
}

// Struct is a struct type of the package.
type Struct struct {
	Name   string
	Doc    string
	Pos    token.Position
	Fields []*Field
}

// Field is an exported field of a struct.
type Field struct {
	Name string // the Go name
	JSON string // its key in JSON
	Doc  string
	Type *Type
}

// Enum is a named string or integer type with constants.
type Enum struct {
	Name   string
	Doc    string
	Pos    token.Position
	String bool
	Basic  string // the underlying Go type: string, int, uint8 …
	Cases  []*EnumCase
}

// EnumCase is one constant of an Enum.
type EnumCase struct {
	Name  string // the Go name
	Value string // its value, as a Go literal: "word", 3
	Doc   string
}

// ErrorVar is an error of the package, made with native.NewError.
type ErrorVar struct {
	Name string // ErrNoEmbedding
	Code string // no_embedding
	Doc  string
}

// SwiftName is the Swift name of an error's case: ErrNoEmbedding →
// noEmbedding.
func (e *ErrorVar) SwiftName() string {
	return swiftIdent(lowerCamel(strings.TrimPrefix(e.Name, "Err")))
}

// lowerCamel lowers the first word of a Go name: DetectLanguage →
// detectLanguage, URLFor → urlFor, ID → id.
func lowerCamel(s string) string {
	r := []rune(s)
	n := 0
	for n < len(r) && unicode.IsUpper(r[n]) {
		n++
	}
	switch {
	case n == 0:
		return s
	case n == len(r):
		return strings.ToLower(s)
	case n > 1 && unicode.IsLower(r[n]):
		n-- // the last capital starts the next word
	}
	for i := range n {
		r[i] = unicode.ToLower(r[i])
	}
	return string(r)
}

// UpperCamel is the name of a package in upper camel case, the name of
// its Swift module: language → Language, media_player → MediaPlayer.
func UpperCamel(s string) string {
	var b strings.Builder
	up := true
	for _, r := range s {
		if r == '_' || r == '-' {
			up = true
			continue
		}
		if up {
			r = unicode.ToUpper(r)
			up = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

var swiftKeywords = map[string]bool{
	"associatedtype": true, "class": true, "deinit": true, "enum": true, "extension": true,
	"fileprivate": true, "func": true, "import": true, "init": true, "inout": true,
	"internal": true, "let": true, "open": true, "operator": true, "private": true,
	"precedencegroup": true, "protocol": true, "public": true, "rethrows": true,
	"static": true, "struct": true, "subscript": true, "typealias": true, "var": true,
	"break": true, "case": true, "catch": true, "continue": true, "default": true,
	"defer": true, "do": true, "else": true, "fallthrough": true, "for": true,
	"guard": true, "if": true, "in": true, "repeat": true, "return": true, "throw": true,
	"switch": true, "where": true, "while": true, "Any": true, "as": true, "await": true,
	"false": true, "is": true, "nil": true, "self": true, "Self": true, "super": true,
	"throws": true, "true": true, "try": true, "Type": true, "Protocol": true,
}

// swiftIdent escapes a Swift keyword used as a name.
func swiftIdent(s string) string {
	if swiftKeywords[s] {
		return "`" + s + "`"
	}
	return s
}
