package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/egoist/mygo/internal/nativegen"
	"github.com/egoist/mygo/internal/nativelib"
)

// Native modules (docs/native-modules.md): Go packages whose interfaces
// Swift, Rust or Zig implement. The CLI generates them, builds their
// implementations and puts them into the app: Swift ones here, into the
// Frameworks of macOS apps, and the others as the libraries packages name
// (natives).

// nativeApp is what the app's native modules add to its bundle.
type nativeApp struct {
	builds []nativeBuild
	// info and entitlements are the keys the modules add to the app's
	// Info.plist and entitlements, merged.
	info, entitlements map[string]any
}

// nativeBuild is the built implementation of a module.
type nativeBuild struct {
	name  string // the Swift module: Language
	dir   string // the Go package's directory
	dylib string
	// frameworks are the dynamic frameworks and libraries its Swift
	// package brings, which go next to it.
	frameworks []string
	// key identifies what it was built from: its sources and those of the
	// modules it uses.
	key string
}

// appNativeModules returns the directories of the native modules among the
// packages of the app for goos/goarch.
func appNativeModules(c *Config, goos, goarch string) ([]string, error) {
	all, err := c.packageDirs(goos, goarch)
	if err != nil {
		return nil, err
	}
	var dirs []string
	for _, dir := range all {
		if nativegen.IsModule(dir) {
			dirs = append(dirs, dir)
		}
	}
	return dirs, nil
}

// nativeMode says what prepareNative does with the modules' generated
// files and builds.
type nativeMode int

const (
	nativeDev     nativeMode = iota // regenerate, build for debugging
	nativeRelease                   // refuse stale files, build for release
)

// prepareNative generates the app's native modules (for development) or
// checks that their generated files are up to date (for release), and on
// macOS builds their Swift implementations for goos/goarch into c.native.
func prepareNative(c *Config, goos, goarch string, mode nativeMode) (err error) {
	c.native = nil
	dirs, err := appNativeModules(c, goos, goarch)
	if err != nil || len(dirs) == 0 && goos != "darwin" {
		return err
	}
	if mode == nativeDev && runtime.GOOS == "darwin" && goos == "darwin" {
		defer func() {
			// For editors only: a failure leaves the app's build alone.
			if err == nil {
				if werr := writeNativePackage(c, dirs); werr != nil {
					warnf("Writing .mygo/native/Package.swift: %v", werr)
				}
			}
		}()
	}
	app := &nativeApp{}
	// Which module set each key, across the modules, and the keys the app
	// sets itself, which win over theirs and settle their conflicts.
	owners := map[string]map[string]string{"Info.plist": {}, "Entitlements.plist": {}}
	appKeys := map[string]map[string]bool{"Info.plist": {}, "Entitlements.plist": {}}
	for k := range c.MacOS.InfoPlist {
		appKeys["Info.plist"][k] = true
	}
	if c.MacOS.Entitlements != "" {
		data, err := os.ReadFile(c.path(c.MacOS.Entitlements))
		if err != nil {
			return err
		}
		own, err := parsePlist(data)
		if err != nil {
			return fmt.Errorf("%s: %w", c.MacOS.Entitlements, err)
		}
		for k := range own {
			appKeys["Entitlements.plist"][k] = true
		}
	}
	for _, dir := range dirs {
		rel := relPathTo(c.root, dir)
		if mode == nativeDev {
			r, err := nativegen.Generate(dir)
			if err != nil {
				return fmt.Errorf("native module %s:\n%w", rel, err)
			}
			for _, w := range r.Written {
				logf("Wrote %s", cyan(relPathTo(c.root, w)))
			}
		} else {
			stale, err := nativegen.Stale(dir)
			if err != nil {
				return fmt.Errorf("native module %s:\n%w", rel, err)
			}
			if len(stale) > 0 {
				return fmt.Errorf("the generated files of native module %s are older than its interfaces (%s): regenerate them with mygo dev, or mygo native check %s, and commit them", rel, relPathTo(c.root, stale[0]), rel)
			}
		}
		// Linux runs a module's Swift under go test and go run only, when
		// no other language implements it.
		lang := moduleLang(dir, goos, "")
		devLinux := mode == nativeDev && goos == "linux" && runtime.GOOS == "linux" && goarch == runtime.GOARCH &&
			lang == "" && nativegen.HasLang(dir, "swift")
		if goos != "darwin" && !devLinux || goos == "darwin" && lang != "swift" {
			continue
		}
		if devLinux {
			if _, err := exec.LookPath("swift"); err != nil {
				continue // the module is unsupported here, as without Swift
			}
			// A module of Apple's frameworks does not build here, which
			// leaves it unsupported rather than failing the app.
			if _, err := buildSwiftModule(dir, goarch, false); err != nil {
				warnf("Native module %s does not build on Linux, where it is unsupported: %v", rel, firstLine(err.Error()))
			}
			continue
		}
		b, err := moduleBuild(c, dir, goarch, mode)
		if err != nil {
			return err
		}
		app.builds = append(app.builds, b)
		for _, kind := range []struct {
			file string
			dst  *map[string]any
		}{{"Info.plist", &app.info}, {"Entitlements.plist", &app.entitlements}} {
			path := filepath.Join(dir, "swift", kind.file)
			data, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				return err
			}
			d, err := parsePlist(data)
			if err != nil {
				return fmt.Errorf("%s: %w", relPathTo(c.root, path), err)
			}
			if *kind.dst == nil {
				*kind.dst = map[string]any{}
			}
			if err := mergePlist(*kind.dst, d, rel, owners[kind.file], appKeys[kind.file], ""); err != nil {
				return fmt.Errorf("%s: %w", kind.file, err)
			}
		}
	}
	// The Swift libraries that packages bind by hand go with the modules'.
	if goos == "darwin" {
		pkgs, err := c.nativePackages(goos, goarch)
		if err != nil {
			return err
		}
		for _, p := range pkgs {
			for _, l := range p.manifest.Libraries {
				if !l.Build.IsSwift() {
					continue
				}
				b, err := swiftBuild(c, p.dir, l, nil, goarch, mode, p.local)
				if err != nil {
					return err
				}
				app.builds = append(app.builds, b)
			}
		}
	}
	// The app's own keys come last and win.
	if app.info != nil {
		for k := range c.MacOS.InfoPlist {
			delete(app.info, k)
		}
	}
	if len(app.builds) > 0 || app.info != nil || app.entitlements != nil {
		c.native = app
	}
	return nil
}

// moduleBuild builds the Swift package of the module in dir, or takes its
// published build (see swiftBuild).
func moduleBuild(c *Config, dir, goarch string, mode nativeMode) (nativeBuild, error) {
	m, err := nativegen.Load(dir)
	if err != nil {
		return nativeBuild{}, err
	}
	lib, err := moduleLibrary(m, "swift")
	if err != nil {
		return nativeBuild{}, err
	}
	return swiftBuild(c, dir, lib, m, goarch, mode, isLocalPackage(dir))
}

// swiftBuild builds the Swift library lib of the package in dir, the
// implementation of the native module m or one that the package binds by
// hand (m nil), or takes its published build: in release builds while it
// matches the sources, wherever Swift is missing, and for packages outside
// the app's own (local), whose sources do not build where they are.
func swiftBuild(c *Config, dir string, lib nativelib.Library, m *nativegen.Module, goarch string, mode nativeMode, local bool) (nativeBuild, error) {
	build := func() (nativeBuild, error) {
		if m != nil {
			return buildSwiftModule(dir, goarch, mode == nativeRelease)
		}
		return buildSwiftLibrary(dir, lib, goarch, mode == nativeRelease)
	}
	f, ok := lib.File("darwin", goarch)
	if !ok {
		return build()
	}
	published := func() (nativeBuild, error) {
		b, err := usePublishedSwift(dir, lib.Name, f)
		if err == nil && mode == nativeDev {
			err = installLocal(dir, b)
		}
		return b, err
	}
	if !local {
		return published()
	}
	hash, err := swiftSourceHash(dir, lib, m)
	if err != nil {
		return nativeBuild{}, err
	}
	_, lookErr := exec.LookPath("swift")
	haveSwift := runtime.GOOS == "darwin" && lookErr == nil
	rel := relPathTo(c.root, dir)
	switch {
	case f.SourceHash == hash && (mode == nativeRelease || !haveSwift):
		return published()
	case f.SourceHash != hash && !haveSwift:
		return nativeBuild{}, fmt.Errorf("the published build of %s in %s is older than its sources, and this machine cannot build them: run mygo native build -upload %s on a Mac, and commit %s", lib.Name, rel, rel, filepath.Join(rel, pluginFile))
	case f.SourceHash != hash && mode == nativeRelease:
		warnf("The published build of %s in %s is older than its sources: building them (mygo native build -upload %s updates it)", lib.Name, rel, rel)
	}
	return build()
}

// swiftSourceHash returns the hash of the sources of the Swift library
// lib of the package in dir, with those of the modules it uses when it is
// the native module m's.
func swiftSourceHash(dir string, lib nativelib.Library, m *nativegen.Module) (string, error) {
	if m != nil {
		return moduleSourceHash(m)
	}
	return nativelib.SourceHash(filepath.Join(dir, filepath.FromSlash(lib.Build.Swift)), lib.Build)
}

// isLocalPackage reports whether the package in dir is outside the module
// cache and vendor directories: the app's own, or a module it replaces
// with a directory, whose libraries build from their sources.
func isLocalPackage(dir string) bool {
	modcache := goEnv("GOMODCACHE")
	return (modcache == "" || !strings.HasPrefix(dir, modcache+string(filepath.Separator))) &&
		!strings.Contains(dir+string(filepath.Separator), string(filepath.Separator)+"vendor"+string(filepath.Separator))
}

// installLocal copies a build of a Swift library of the package in dir,
// and the frameworks it brings, to where go run and go test find it: the
// CLI's builds in the module (nativelib.LocalDir).
func installLocal(dir string, b nativeBuild) error {
	root, err := nativelib.ModuleRoot(dir)
	if err != nil {
		return err
	}
	dst := nativelib.LocalDir(root, runtime.GOOS, runtime.GOARCH)
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, f := range append([]string{b.dylib}, b.frameworks...) {
		if err := copyPath(f, filepath.Join(dst, filepath.Base(f))); err != nil {
			return err
		}
	}
	return nil
}

// swiftArchs are the architectures of swift build for a GOARCH.
func swiftArchs(goarch string) []string {
	switch goarch {
	case "universal":
		return []string{"--arch", "arm64", "--arch", "x86_64"}
	case "amd64":
		return []string{"--arch", "x86_64"}
	}
	return []string{"--arch", "arm64"}
}

// buildSwiftModule builds the Swift package of the module in dir, for
// goarch, and copies a debug build of the host's architecture to where
// the module's generated Go finds it under go run and go test.
//
// The native modules it uses build first: it imports their Swift modules
// and links their libraries, which it finds next to it in the app, and
// loaded already under go test.
func buildSwiftModule(dir, goarch string, release bool) (nativeBuild, error) {
	m, err := nativegen.Load(dir)
	if err != nil {
		return nativeBuild{}, err
	}
	hash, err := nativelib.SourceHash(filepath.Join(dir, "swift"), &nativelib.Build{Swift: "./swift"})
	if err != nil {
		return nativeBuild{}, err
	}
	key := fmt.Sprint(m.Dir, goarch, release, hash)
	var depFlags []string
	for _, path := range slices.Sorted(maps.Keys(m.Deps)) {
		dep := m.Deps[path]
		if !release {
			// Release builds refuse stale files; others regenerate them.
			if _, err := nativegen.Generate(dep.Dir); err != nil {
				return nativeBuild{}, err
			}
		}
		d, err := buildSwiftModule(dep.Dir, goarch, release)
		if err != nil {
			return nativeBuild{}, err
		}
		bin := filepath.Dir(d.dylib)
		// SwiftPM puts the .swiftmodule of a build in Modules, from Swift
		// 6, and next to the library before.
		depFlags = append(depFlags, "-Xswiftc", "-I", "-Xswiftc", filepath.Join(bin, "Modules"), "-Xswiftc", "-I", "-Xswiftc", bin, "-Xlinker", "-L", "-Xlinker", bin, "-Xlinker", "-l"+dep.Name)
		key += " " + d.key // it changes with them
	}
	return buildSwiftProduct(dir, filepath.Join(dir, "swift"), m.Name, "native module "+m.Package, depFlags, key, goarch, release)
}

// buildSwiftLibrary builds the Swift library lib that the package in dir
// binds by hand, for goarch (see buildSwiftModule).
func buildSwiftLibrary(dir string, lib nativelib.Library, goarch string, release bool) (nativeBuild, error) {
	src := filepath.Join(dir, filepath.FromSlash(lib.Build.Swift))
	hash, err := nativelib.SourceHash(src, lib.Build)
	if err != nil {
		return nativeBuild{}, err
	}
	return buildSwiftProduct(dir, src, lib.Name, lib.Name, lib.Build.Args, fmt.Sprint(src, goarch, release, hash), goarch, release)
}

// buildSwiftProduct builds the dynamic library product of the Swift
// package in src, of the Go package in dir, with more arguments of swift
// build; key identifies what it builds from, built once per run of the
// CLI. what names it in messages.
func buildSwiftProduct(dir, src, product, what string, args []string, key, goarch string, release bool) (nativeBuild, error) {
	builtMu.Lock()
	b, ok := built[key]
	builtMu.Unlock()
	if ok {
		return b, nil
	}
	// Linux builds this machine's debug build, for go test and go run.
	linux := runtime.GOOS == "linux" && !release && goarch == runtime.GOARCH
	if runtime.GOOS != "darwin" && !linux {
		return nativeBuild{}, fmt.Errorf("%s is implemented in Swift, which builds on macOS, with Xcode or its Command Line Tools", what)
	}
	if _, err := exec.LookPath("swift"); err != nil {
		return nativeBuild{}, fmt.Errorf("%s needs Swift: install Xcode or its Command Line Tools (xcode-select --install)", what)
	}
	config := "debug"
	if release {
		config = "release"
	}
	cmdArgs := []string{"build", "--package-path", src, "-c", config, "--product", product}
	if !linux {
		cmdArgs = append(cmdArgs, swiftArchs(goarch)...)
	}
	cmdArgs = append(cmdArgs, args...)
	t := con.start("Building " + what)
	var out bytes.Buffer
	cmd := exec.Command("swift", cmdArgs...)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return nativeBuild{}, t.end(fmt.Errorf("swift build of %s: %v\n%s", what, err, swiftProblems(out.String())), "")
	}
	bin, err := exec.Command("swift", append(append([]string{}, cmdArgs...), "--show-bin-path")...).Output()
	if err != nil {
		return nativeBuild{}, t.end(fmt.Errorf("swift build --show-bin-path: %v", err), "")
	}
	binDir := strings.TrimSpace(string(bin))
	b = nativeBuild{name: product, dir: dir, dylib: filepath.Join(binDir, nativelib.FileName(product, runtime.GOOS)), key: key}
	if _, err := os.Stat(b.dylib); err != nil {
		return nativeBuild{}, t.end(fmt.Errorf("%s: swift build made no %s: keep the product %s a dynamic library in Package.swift", what, filepath.Base(b.dylib), product), "")
	}
	entries, _ := os.ReadDir(binDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".framework") || (strings.HasSuffix(e.Name(), ".dylib") && e.Name() != filepath.Base(b.dylib)) {
			b.frameworks = append(b.frameworks, filepath.Join(binDir, e.Name()))
		}
	}
	if !release {
		if err := installLocal(dir, b); err != nil {
			return nativeBuild{}, t.end(err, "")
		}
	}
	builtMu.Lock()
	built[key] = b
	builtMu.Unlock()
	return b, t.end(nil, "Built "+what)
}

// built are the modules built by this run of the CLI, by their
// directories, targets and sources.
var (
	builtMu sync.Mutex
	built   = map[string]nativeBuild{}
)

// swiftProblems keeps the lines of the compiler's errors, with what
// follows each, out of swift build's output.
func swiftProblems(out string) string {
	out = ansiEscape.ReplaceAllString(out, "")
	var keep []string
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		if strings.Contains(l, "error:") {
			keep = append(keep, l)
			for j := i + 1; j < len(lines) && j < i+4 && strings.HasPrefix(strings.TrimSpace(lines[j]), "|"); j++ {
				keep = append(keep, lines[j])
			}
		}
	}
	if len(keep) == 0 {
		return strings.TrimSpace(out)
	}
	return strings.Join(slices.Compact(keep), "\n")
}

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\`)

// copyPath copies a file, or a directory such as a framework, with its
// links.
func copyPath(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if runtime.GOOS != "darwin" {
		// Off macOS, the builds of go test are a library, no bundle.
		return replaceFile(src, dst)
	}
	out, err := exec.Command("ditto", src, dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("copying %s: %v\n%s", src, err, out)
	}
	return nil
}

// installNative puts the implementations of the app's modules into the
// Frameworks of the bundle app, for goarch.
func installNative(c *Config, app string) error {
	if c.native == nil || len(c.native.builds) == 0 {
		return nil
	}
	dir := filepath.Join(app, "Contents", "Frameworks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, b := range c.native.builds {
		for _, f := range append([]string{b.dylib}, b.frameworks...) {
			dst := filepath.Join(dir, filepath.Base(f))
			if _, err := os.Stat(dst); err == nil && f != b.dylib {
				continue // another module brought it
			}
			if err := copyPath(f, dst); err != nil {
				return err
			}
		}
	}
	return nil
}

// nativeEntitlements returns the entitlements file to sign the app with:
// the app's, merged with its modules', in a file of dir.
func nativeEntitlements(c *Config, dir string) (string, error) {
	app := ""
	if c.MacOS.Entitlements != "" {
		app = c.path(c.MacOS.Entitlements)
	}
	if c.native == nil || len(c.native.entitlements) == 0 {
		return app, nil
	}
	merged := map[string]any{}
	for k, v := range c.native.entitlements {
		merged[k] = v
	}
	if app != "" {
		data, err := os.ReadFile(app)
		if err != nil {
			return "", err
		}
		own, err := parsePlist(data)
		if err != nil {
			return "", fmt.Errorf("%s: %w", c.MacOS.Entitlements, err)
		}
		for k, v := range own {
			merged[k] = v
		}
	}
	var b bytes.Buffer
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n")
	writePlistValue(&b, merged, "")
	b.WriteString("</plist>\n")
	path := filepath.Join(dir, ".mygo-entitlements.plist")
	return path, os.WriteFile(path, b.Bytes(), 0o644)
}

// mergePlist merges src, from the module named from, into dst: dictionaries
// by key, arrays by their values. Two modules setting one key to different
// values is an error naming both. owners maps key paths to the module that
// set them.
func mergePlist(dst, src map[string]any, from string, owners map[string]string, app map[string]bool, prefix string) error {
	for k, v := range src {
		key := prefix + k
		old, ok := dst[k]
		if !ok {
			dst[k] = v
			owners[key] = from
			continue
		}
		if top, _, _ := strings.Cut(key, "."); app[top] {
			continue // the app's own value replaces both
		}
		switch o := old.(type) {
		case map[string]any:
			if s, ok := v.(map[string]any); ok {
				if err := mergePlist(o, s, from, owners, app, key+"."); err != nil {
					return err
				}
				continue
			}
		case []any:
			if s, ok := v.([]any); ok {
				for _, x := range s {
					if !slices.ContainsFunc(o, func(y any) bool { return plistEqual(x, y) }) {
						o = append(o, x)
					}
				}
				dst[k] = o
				continue
			}
		}
		if !plistEqual(old, v) {
			return fmt.Errorf("native modules %s and %s set %s to different values: set it in the app's configuration, which wins", owners[key], from, key)
		}
	}
	return nil
}

func plistEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// runNative runs the commands of `mygo native`.
func runNative(args []string) error {
	const usage = `Usage: mygo native <command> [arguments]

Native modules: Go packages whose interfaces are implemented in Swift, Rust
or Zig, built into a library per platform and published with the package
(docs/native-modules.md). Packages that bind a C library with ffi name it
the same way. Experimental: they may change in breaking ways in any release.

	build [flags] [dir]                     build the native modules and libraries of the packages in dir, ready to publish
	new [-lang <languages>] <module name>   make a module in modules/<name>, or at a path
	add <language> [module dir]             implement a module in another language: swift, rust or zig
	check [module dir]                      generate, build and vet a module, listing problems
	call [-timeout <d>] [module dir] <Interface>.<Method> [<arguments>]
	                                        call a method and print its result as JSON
`
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return flagErrHelp()
	}
	switch args[0] {
	case "build":
		return runNativeBuild(args[1:])
	case "new":
		return runNativeNew(args[1:])
	case "add":
		return runNativeAdd(args[1:])
	case "check":
		return runNativeCheck(args[1:])
	case "call":
		return runNativeCall(args[1:])
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	}
	fmt.Fprint(os.Stderr, usage)
	return fmt.Errorf("unknown command mygo native %s", args[0])
}

func runNativeNew(args []string) error {
	fs := newFlags("native new", "[-lang <languages>] <module name>", `Makes a native module named <module name> in modules/<module name>, or at the
path given instead of a name: the Go package declaring its interface, its
generated Go, an AGENTS.md, and a directory per language implementing it.
Swift serves macOS, where it reaches Apple's frameworks; Rust and Zig serve
every platform. A module in several languages is built in Swift on macOS,
and in Rust, or else Zig, elsewhere.`)
	langs := fs.String("lang", "swift", "the languages to implement it in, separated by commas: swift, rust, zig, or none for the Go side alone")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return flagErrHelp()
	}
	arg := fs.Arg(0)
	dir := arg
	if !strings.ContainsAny(arg, `/\`) {
		dir = filepath.Join("modules", arg)
	}
	var list []string
	if *langs != "none" {
		list = splitList(*langs)
		for _, l := range list {
			if !slices.Contains(nativegen.Langs, l) {
				return fmt.Errorf("unknown language %q: modules are implemented in %s, or none", l, strings.Join(nativegen.Langs, ", "))
			}
		}
	}
	if err := nativegen.Scaffold(dir, filepath.Base(dir), list); err != nil {
		return err
	}
	logf("Made native module %s in %s", filepath.Base(dir), cyan(dir))
	return nil
}

func runNativeAdd(args []string) error {
	fs := newFlags("native add", "<language> [module dir]", "Implements an existing module in another language (swift, rust or zig), with\nmethods that say they are unsupported, so that the module builds at once.")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		fs.Usage()
		return flagErrHelp()
	}
	dir := dirArg(fs.Args()[1:])
	if err := nativegen.AddLang(dir, fs.Arg(0)); err != nil {
		return err
	}
	logf("Added %s to %s", fs.Arg(0), cyan(dir))
	return nil
}

// runNativeCheck generates, builds and vets a module, and lists its
// problems as file:line: message.
func runNativeCheck(args []string) error {
	fs := newFlags("native check", "[-lang <language>] [module dir]", "Generates the module, builds its implementation for this machine and vets the\nGo package, then lists every problem as file:line: message. It exits with\nstatus 1 when there are problems.")
	lang := fs.String("lang", "", "build the implementation in this language (default: the one this machine uses)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir := dirArg(fs.Args())
	var problems []string
	_, err := nativegen.Generate(dir)
	var diags nativegen.Errors
	switch {
	case errors.As(err, &diags):
		for _, d := range diags {
			if d.Pos.Filename != "" {
				d.Pos.Filename = filepath.Join(dir, d.Pos.Filename)
			}
			problems = append(problems, d.String())
		}
	case err != nil:
		return err
	}
	if err == nil {
		if err := buildModuleHere(dir, *lang); err != nil {
			problems = append(problems, strings.TrimSpace(err.Error()))
		}
	}
	if err == nil {
		var out bytes.Buffer
		cmd := goCommand(dir, nil, "vet", ".")
		cmd.Stdout, cmd.Stderr = &out, &out
		if cmd.Run() != nil {
			for l := range strings.Lines(out.String()) {
				if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "#") {
					problems = append(problems, l)
				}
			}
		}
	}
	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Println(p)
		}
		return errSilent
	}
	logf("Native module %s is fine", cyan(dir))
	return nil
}

// buildModuleHere builds the implementation of the module in dir for this
// machine, in lang or the one it uses here (moduleLang), where go run and
// go test find it. Swift builds on Linux only when lang asks for it, as
// modules of Apple's frameworks do not; a module with no implementation
// for this machine builds nothing.
func buildModuleHere(dir, lang string) error {
	switch l := moduleLang(dir, runtime.GOOS, lang); {
	case l == "" && lang != "":
		return fmt.Errorf("%s is not implemented in %s for %s", dir, lang, runtime.GOOS)
	case l == "swift":
		if runtime.GOOS != "darwin" && lang != "swift" {
			return nil
		}
		_, err := buildSwiftModule(dir, runtime.GOARCH, false)
		return err
	case l != "":
		m, err := nativegen.Load(dir)
		if err != nil {
			return err
		}
		lib, err := moduleLibrary(m, l)
		if err != nil {
			return err
		}
		_, err = buildNative(dir, lib, runtime.GOOS, runtime.GOARCH, "")
		return err
	}
	return nil
}

// errSilent makes main exit with status 1 without printing more.
var errSilent = flag.ErrHelp

func flagErrHelp() error { return errSilent }

// generateNative generates the app's native modules and builds their
// implementations where go test and go run find them.
func generateNative(c *Config) error {
	if err := prepareNative(c, runtime.GOOS, runtime.GOARCH, nativeDev); err != nil {
		return err
	}
	// The libraries of the modules Rust or Zig implement here, built or
	// downloaded, where their packages load them from.
	pkgs, err := c.nativePackages(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	pkgs = slices.DeleteFunc(pkgs, func(p nativePackage) bool { return p.module == nil })
	for i := range pkgs {
		m := pkgs[i].module
		l, _ := pkgs[i].manifest.Lookup(m.Name)
		pkgs[i].manifest.Libraries = []nativelib.Library{l}
	}
	_, err = c.nativesOf(pkgs, runtime.GOOS, runtime.GOARCH)
	return err
}

// hashNative writes what the app's native modules put into it, so that
// mygo dev relaunches the app when they change.
func hashNative(w io.Writer, c *Config) error {
	if c.native == nil {
		return nil
	}
	for _, b := range c.native.builds {
		for _, f := range append([]string{b.dylib}, b.frameworks...) {
			info, err := os.Stat(f)
			if err != nil {
				return err
			}
			fmt.Fprintf(w, "%s\x00%d\x00%d\x00", f, info.Size(), info.ModTime().UnixNano())
		}
	}
	data, _ := json.Marshal([]any{c.native.info, c.native.entitlements})
	_, err := w.Write(data)
	return err
}

// parsePlist reads an XML property list whose root is a dictionary, as
// JSON would decode it: maps, slices, strings, float64 and bools.
func parsePlist(data []byte) (map[string]any, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	var value func(start xml.StartElement) (any, error)
	text := func() (string, error) {
		var s strings.Builder
		for {
			tok, err := d.Token()
			if err != nil {
				return "", err
			}
			switch t := tok.(type) {
			case xml.CharData:
				s.Write(t)
			case xml.EndElement:
				return s.String(), nil
			case xml.StartElement:
				return "", fmt.Errorf("unexpected <%s>", t.Name.Local)
			}
		}
	}
	next := func() (xml.Token, error) {
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch tok.(type) {
			case xml.StartElement, xml.EndElement:
				return tok, nil
			}
		}
	}
	value = func(start xml.StartElement) (any, error) {
		switch start.Name.Local {
		case "dict":
			m := map[string]any{}
			for {
				tok, err := next()
				if err != nil {
					return nil, err
				}
				if _, ok := tok.(xml.EndElement); ok {
					return m, nil
				}
				k := tok.(xml.StartElement)
				if k.Name.Local != "key" {
					return nil, fmt.Errorf("a dict holds <key>, not <%s>", k.Name.Local)
				}
				key, err := text()
				if err != nil {
					return nil, err
				}
				tok, err = next()
				if err != nil {
					return nil, err
				}
				v, ok := tok.(xml.StartElement)
				if !ok {
					return nil, fmt.Errorf("key %s has no value", key)
				}
				if m[key], err = value(v); err != nil {
					return nil, err
				}
			}
		case "array":
			a := []any{}
			for {
				tok, err := next()
				if err != nil {
					return nil, err
				}
				if _, ok := tok.(xml.EndElement); ok {
					return a, nil
				}
				v, err := value(tok.(xml.StartElement))
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
		case "true", "false":
			if _, err := text(); err != nil {
				return nil, err
			}
			return start.Name.Local == "true", nil
		case "integer", "real":
			s, err := text()
			if err != nil {
				return nil, err
			}
			f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
			if err != nil {
				return nil, fmt.Errorf("<%s>%s</%s>: %v", start.Name.Local, s, start.Name.Local, err)
			}
			return f, nil
		case "string", "date", "data":
			return text()
		}
		return nil, fmt.Errorf("unknown property list element <%s>", start.Name.Local)
	}
	for {
		tok, err := next()
		if err != nil {
			return nil, fmt.Errorf("not a property list: %v", err)
		}
		if s, ok := tok.(xml.StartElement); ok && s.Name.Local != "plist" {
			if s.Name.Local != "dict" {
				return nil, fmt.Errorf("the property list holds a <%s>, not a <dict>", s.Name.Local)
			}
			v, err := value(s)
			if err != nil {
				return nil, err
			}
			return v.(map[string]any), nil
		}
	}
}

// firstLine returns the first line of s.
func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}
