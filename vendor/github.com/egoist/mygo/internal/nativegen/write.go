package nativegen

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Langs are the languages a module may be implemented in, each in the
// directory of its name: a Swift package, a Rust crate or a Zig package.
var Langs = []string{"swift", "rust", "zig"}

// langManifest is the file that makes a language's directory a package.
var langManifest = map[string]string{"swift": "Package.swift", "rust": "Cargo.toml", "zig": "build.zig"}

// SwiftDir is the directory of a module's Swift sources.
func SwiftDir(m *Module) string { return filepath.Join(m.Dir, "swift", "Sources", m.Name) }

// HasLang reports whether the module in dir is implemented in lang.
func HasLang(dir, lang string) bool {
	f, ok := langManifest[lang]
	if !ok {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, lang, f))
	return err == nil
}

// ModuleLangs returns the languages the module in dir is implemented in.
func ModuleLangs(dir string) []string {
	var langs []string
	for _, l := range Langs {
		if HasLang(dir, l) {
			langs = append(langs, l)
		}
	}
	return langs
}

// GeneratedFile is the path of the generated file of a module in lang.
func GeneratedFile(m *Module, lang string) string {
	switch lang {
	case "swift":
		return filepath.Join(SwiftDir(m), SwiftFile(m))
	case "rust":
		return filepath.Join(m.Dir, "rust", "src", RustFile)
	}
	return filepath.Join(m.Dir, "zig", "src", ZigFile)
}

// generate writes the generated file of a module in lang.
func generate(m *Module, lang string) ([]byte, error) {
	switch lang {
	case "swift":
		return GenerateSwift(m), nil
	case "rust":
		return GenerateRust(m)
	}
	return GenerateZig(m)
}

var macOSPlatform = regexp.MustCompile(`\.macOS\(\s*(?:\.v(\d+)(?:_(\d+))?|"([\d.]+)")\s*\)`)

// MinMacOS reads the oldest macOS the Swift package in dir supports from
// the platforms of its Package.swift, or "" when it names none.
func MinMacOS(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "swift", "Package.swift"))
	if err != nil {
		return ""
	}
	m := macOSPlatform.FindSubmatch(data)
	switch {
	case m == nil:
		return ""
	case len(m[3]) > 0:
		return string(m[3])
	case len(m[2]) > 0:
		return string(m[1]) + "." + string(m[2])
	}
	return string(m[1])
}

// Result is what Generate wrote.
type Result struct {
	Module  *Module
	Written []string // the files that changed
}

// Generate loads the module in dir and writes its generated files,
// leaving those that are up to date.
func Generate(dir string) (*Result, error) {
	m, err := Load(dir)
	if err != nil {
		return nil, err
	}
	r := &Result{Module: m}
	langs := ModuleLangs(m.Dir)
	goSrc, err := GenerateGo(m, langs, MinMacOS(m.Dir))
	if err != nil {
		return nil, err
	}
	if err := r.write(filepath.Join(m.Dir, GeneratedGo(m.Package)), goSrc); err != nil {
		return nil, err
	}
	for _, lang := range langs {
		src, err := generate(m, lang)
		if err != nil {
			return nil, err
		}
		if err := r.write(GeneratedFile(m, lang), src); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (r *Result) write(path string, data []byte) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	r.Written = append(r.Written, path)
	return nil
}

// Stale returns the generated files of the module in dir that are older
// than its interface, or missing.
func Stale(dir string) ([]string, error) {
	m, err := Load(dir)
	if err != nil {
		return nil, err
	}
	line := SourceLine(m.Hash)
	var stale []string
	check := func(path string) {
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Contains(data, []byte(line)) {
			stale = append(stale, path)
		}
	}
	check(filepath.Join(m.Dir, GeneratedGo(m.Package)))
	for _, lang := range ModuleLangs(m.Dir) {
		check(GeneratedFile(m, lang))
	}
	return stale, nil
}

// IsModule reports whether dir holds a native module: a Go package whose
// generated file nativegen wrote.
func IsModule(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), "_native.go") && isGenerated(filepath.Join(dir, e.Name())) {
			return true
		}
	}
	return false
}

// Scaffold writes a new module named pkg in dir, implemented in the
// languages given.
func Scaffold(dir, pkg string, langs []string) error {
	if !validPackage(pkg) {
		return fmt.Errorf("%q is not a Go package name: use lower case letters and digits, as language or media", pkg)
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s is not empty", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	name := UpperCamel(pkg)
	files := map[string]string{
		pkg + ".go": fmt.Sprintf(goTemplate, pkg, name),
		"AGENTS.md": strings.ReplaceAll(strings.ReplaceAll(agentsTemplate, "PKG", pkg), "MODULE", name),
	}
	for path, content := range files {
		if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0o644); err != nil {
			return err
		}
	}
	if _, err := Generate(dir); err != nil {
		return err
	}
	for _, l := range langs {
		if err := AddLang(dir, l); err != nil {
			return err
		}
	}
	return nil
}

func validPackage(s string) bool {
	if s == "" || s == "main" || !(s[0] >= 'a' && s[0] <= 'z') {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}

// AddLang adds a language's directory to the module in dir: a package
// whose every method says it is unsupported, so the module builds at once.
func AddLang(dir, lang string) error {
	if _, ok := langManifest[lang]; !ok {
		return fmt.Errorf("unknown language %q: modules are implemented in %s", lang, strings.Join(Langs, ", "))
	}
	if HasLang(dir, lang) {
		return fmt.Errorf("%s already has %s/", dir, lang)
	}
	m, err := Load(dir)
	if err != nil {
		return err
	}
	pkg := filepath.Join(m.Dir, lang)
	var files map[string][]byte
	switch lang {
	case "swift":
		files = map[string][]byte{
			filepath.Join(pkg, "Package.swift"):         []byte(strings.ReplaceAll(packageTemplate, "MODULE", m.Name)),
			filepath.Join(pkg, ".gitignore"):            []byte("/.build\n/.swiftpm\n"),
			filepath.Join(SwiftDir(m), m.Name+".swift"): stubSwift(m),
		}
	case "rust":
		if err := portable(m, "Rust"); err != nil {
			return err
		}
		files = map[string][]byte{
			filepath.Join(pkg, "Cargo.toml"):    []byte(strings.ReplaceAll(cargoTemplate, "PKG", m.Package)),
			filepath.Join(pkg, ".gitignore"):    []byte("/target\n"),
			filepath.Join(pkg, "src", "lib.rs"): stubRust(m),
		}
	case "zig":
		if err := portable(m, "Zig"); err != nil {
			return err
		}
		files = map[string][]byte{
			filepath.Join(pkg, "build.zig"):             []byte(strings.ReplaceAll(zigBuildTemplate, "MODULE", m.Name)),
			filepath.Join(pkg, ".gitignore"):            []byte("/zig-out\n/.zig-cache\n/zig-pkg\n"),
			filepath.Join(pkg, "src", m.Package+".zig"): stubZig(m),
		}
	}
	for path, data := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
	}
	_, err = Generate(dir)
	return err
}

// stubSwift is an implementation whose every method says it is
// unsupported, to fill in one at a time.
func stubSwift(m *Module) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "import Foundation\n#if canImport(AppKit)\nimport AppKit\n#endif\n\n// The implementation of package %s on Apple's platforms. Implement the\n// methods one at a time: each says it is unsupported until it does.\n", m.Package)
	g := &swiftGen{m: m, b: &b}
	for _, it := range m.Interfaces {
		if it.ByGo {
			continue
		}
		attr := ""
		if it.MainThread {
			attr = "@MainActor "
		}
		class := "Native" + it.Name
		if it.Entry {
			fmt.Fprintf(&b, "\n%sfunc make%s() throws -> any %s { %s() }\n", attr, it.Name, it.Name, class)
		}
		base := it.Name
		if it.View {
			base = "NSView, " + it.Name
		}
		fmt.Fprintf(&b, "\n%sfinal class %s: %s {\n", attr, class, base)
		for _, me := range it.Methods {
			req := g.requirement(it, me)
			var body string
			switch {
			case me.Close:
				req, body = "func close() throws", ""
			case me.Stream == 1:
				body = "AsyncStream { $0.finish() }"
			case me.Stream == 2:
				body = "AsyncThrowingStream { $0.finish(throwing: NativeError.unsupported) }"
			case me.Closer:
				body = "NativeCloser {}"
			case me.Err:
				body = "throw NativeError.unsupported"
			case me.Result == nil:
				body = ""
			default:
				body = "fatalError(\"" + it.Name + "." + me.Name + " is not implemented\")"
			}
			fmt.Fprintf(&b, "    %s {\n", req)
			if body != "" {
				fmt.Fprintf(&b, "        %s\n", body)
			}
			b.WriteString("    }\n")
		}
		b.WriteString("}\n")
	}
	return b.Bytes()
}

const goTemplate = `// Package %[1]s is a native module: its interfaces are implemented in
// Swift, Rust or Zig, in the directory of the language (see AGENTS.md).
package %[1]s

// Greeter greets.
//
//mygo:native
type Greeter interface {
	// Greet returns a greeting for name.
	Greet(name string) (string, error)
}
`

const packageTemplate = `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MODULE",
    platforms: [.macOS(.v13)],
    products: [.library(name: "MODULE", type: .dynamic, targets: ["MODULE"])],
    dependencies: [],
    targets: [
        .target(name: "MODULE"),
    ],
    swiftLanguageModes: [.v5]
)
`

const agentsTemplate = "# Native module PKG\n\n" +
	"PKG is a native module of MyGo: Go interfaces implemented in Swift, Rust or\n" +
	"Zig. Read https://mygo.dev/docs/native-modules (docs/native-modules.md)\n" +
	"before changing it.\n\n" +
	"- `PKG.go` declares the interfaces, the types they use and the errors\n" +
	"  (`native.NewError`): it is the contract. `//mygo:native` marks an entry point,\n" +
	"  which gets a constructor, `NewT`.\n" +
	"- `PKG_native.go` and each language's generated file\n" +
	"  (`swift/Sources/MODULE/MODULE.mygo.swift`, `rust/src/mygo.rs`,\n" +
	"  `zig/src/mygo.zig`) are generated: never edit them; `mygo dev`\n" +
	"  regenerates them when the interfaces change.\n" +
	"- `swift/` is a Swift package, which macOS uses when it is there, for\n" +
	"  Apple's frameworks: a factory `makeT()` per entry point and classes\n" +
	"  conforming to the generated protocols. Add Swift packages and frameworks\n" +
	"  in `swift/Package.swift`.\n" +
	"- `rust/` is a Rust crate and `zig/` a Zig package, for every platform: a\n" +
	"  factory per entry point (`make_t` in Rust, `makeT` in Zig) and types\n" +
	"  implementing the generated traits or declarations.\n\n" +
	"Check the module without opening the app:\n\n" +
	"```sh\n" +
	"mygo native check            # generate, build and vet: every problem as file:line\n" +
	"mygo native call Greeter.Greet '{\"name\": \"Ada\"}'   # call a method, print its result\n" +
	"```\n"

const cargoTemplate = `[package]
name = "PKG"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
`
