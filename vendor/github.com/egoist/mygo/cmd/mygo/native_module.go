package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/egoist/mygo/internal/nativegen"
	"github.com/egoist/mygo/internal/nativelib"
)

// A native module is implemented in Swift, Rust or Zig, in a directory
// named after the language, and may be in several: the CLI builds one per
// platform (moduleLang), as the library named after the module, which its
// package's mygo-plugin.json publishes with no build, since its languages
// are how it builds.

// moduleLang returns the language that implements the module in dir on
// goos, or "" when none does: on macOS Swift first, which reaches Apple's
// frameworks, then Rust and Zig; elsewhere Rust, then Zig. Swift serves
// Linux under go test and go run only (prepareNative). lang, when not "",
// picks the module's implementation in it instead, where it has one.
func moduleLang(dir, goos, lang string) string {
	langs := []string{"rust", "zig"}
	if goos == "darwin" {
		langs = []string{"swift", "rust", "zig"}
	}
	if lang != "" {
		langs = []string{lang}
		if lang == "swift" && goos != "darwin" && goos != "linux" {
			langs = nil
		}
	}
	for _, l := range langs {
		if nativegen.HasLang(dir, l) {
			return l
		}
	}
	return ""
}

// langBuild returns how a module's library builds in lang, or nil.
func langBuild(lang string) *nativelib.Build {
	switch lang {
	case "swift":
		return &nativelib.Build{Swift: "./swift"}
	case "rust":
		return &nativelib.Build{Cargo: "./rust"}
	case "zig":
		return &nativelib.Build{Zig: "./zig"}
	}
	return nil
}

// readManifest reads the mygo-plugin.json in dir, and reports whether
// there is one.
func readManifest(dir string) (nativelib.Manifest, bool, error) {
	path := filepath.Join(dir, pluginFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nativelib.Manifest{}, false, nil
	} else if err != nil {
		return nativelib.Manifest{}, false, err
	}
	m, err := nativelib.Parse(data)
	if err != nil {
		return m, false, fmt.Errorf("%s: %w", path, err)
	}
	return m, true, nil
}

// addModuleLibrary adds the library of native module m to man, its
// package's manifest, when man does not name it, and checks the entry
// when it does.
func addModuleLibrary(man *nativelib.Manifest, m *nativegen.Module) error {
	if l, ok := man.Lookup(m.Name); ok {
		if l.Build != nil {
			return fmt.Errorf("%s: library %s is the native module's, which builds from its %s directories: leave its build out", filepath.Join(m.Dir, pluginFile), m.Name, "swift, rust or zig")
		}
		return nil
	}
	man.Libraries = append(man.Libraries, nativelib.Library{Name: m.Name})
	return nil
}

// moduleLibrary returns the library of native module m, with its
// published files as its package's mygo-plugin.json names them, built in
// lang.
func moduleLibrary(m *nativegen.Module, lang string) (nativelib.Library, error) {
	man, _, err := readManifest(m.Dir)
	if err != nil {
		return nativelib.Library{}, err
	}
	if err := addModuleLibrary(&man, m); err != nil {
		return nativelib.Library{}, err
	}
	l, _ := man.Lookup(m.Name)
	l.Build = langBuild(lang)
	return l, nil
}

// library returns l, which the package names, with how it builds for
// goos: a native module's in the language that implements it there,
// none when no language does.
func (p nativePackage) library(l nativelib.Library, goos, lang string) nativelib.Library {
	if p.isModule(l) {
		l.Build = langBuild(moduleLang(p.dir, goos, lang))
	}
	return l
}

// isModule reports whether l is the library of the native module the
// package is.
func (p nativePackage) isModule(l nativelib.Library) bool {
	return p.module != nil && l.Name == p.module.Name
}
