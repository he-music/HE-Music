// Package nativelib is what the CLI and packages ffi and native share about
// the native libraries that Go packages bind: mygo-plugin.json, the file
// names of libraries on each platform, and where libraries are built and
// cached.
//
// A package names its libraries in mygo-plugin.json, next to its sources:
//
//	{"libraries": [{
//		"name": "adder",
//		"build": {"cargo": "./rust"},
//		"release": "https://github.com/me/app/releases/download/adder-v1",
//		"files": {"darwin-arm64": {"name": "libadder.dylib", "url": "…", "sha256": "…"}, …}
//	}]}
//
// build is how the CLI builds the library from its sources (a Rust crate
// with cargo, a Zig package with zig build, a Swift package with swift
// build, on macOS); files are the published builds,
// one per platform (GOOS-GOARCH), which `mygo native build` writes and
// apps download when they do not build the library themselves.
package nativelib

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ManifestFile is the file that names a package's native libraries.
const ManifestFile = "mygo-plugin.json"

// Manifest is the content of mygo-plugin.json.
type Manifest struct {
	Libraries []Library `json:"libraries"`
}

// Library is a native library a package binds.
type Library struct {
	// Name names the library, as ffi.New does: its files are
	// lib<name>.dylib, lib<name>.so and <name>.dll by default (a leading
	// "lib" is not doubled, and dropped on Windows).
	Name string `json:"name"`
	// Build builds the library from sources next to the package.
	Build *Build `json:"build,omitempty"`
	// Release is the URL of the directory the files are published in,
	// as https://github.com/<owner>/<repo>/releases/download/<tag>.
	Release string `json:"release,omitempty"`
	// Files are the published builds, by GOOS-GOARCH, or Universal for
	// one that serves both architectures of macOS.
	Files map[string]File `json:"files,omitempty"`
}

// Universal is the key of Library.Files for a build of macOS's two
// architectures in one file, as Swift libraries are published.
const Universal = "darwin-universal"

// File returns the published build of the library for goos/goarch: the
// platform's own, or on macOS the universal one.
func (l Library) File(goos, goarch string) (File, bool) {
	if f, ok := l.Files[goos+"-"+goarch]; ok {
		return f, true
	}
	if goos == "darwin" {
		f, ok := l.Files[Universal]
		return f, ok
	}
	return File{}, false
}

// IsArchive reports whether a published file is a .tar.gz of the library
// and the files that go next to it, as the frameworks a Swift package
// brings, rather than the library itself.
func IsArchive(name string) bool { return strings.HasSuffix(name, ".tar.gz") }

// Build is how a library is built from its sources: exactly one of Cargo,
// Zig and Swift, a directory relative to the package's, written "./rust"
// to read as one.
type Build struct {
	// Cargo is the directory of the Rust crate (its Cargo.toml), whose
	// crate-type includes "cdylib".
	Cargo string `json:"cargo,omitempty"`
	// Zig is the directory of the Zig package (its build.zig), which
	// installs a dynamic library.
	Zig string `json:"zig,omitempty"`
	// Swift is the directory of the Swift package (its Package.swift),
	// whose product named as the library is a dynamic library. Swift
	// libraries build on macOS, universal, and go into the app's
	// Frameworks with the frameworks they bring.
	Swift string `json:"swift,omitempty"`
	// Args are more arguments of `cargo build`, `zig build` or `swift
	// build`.
	Args []string `json:"args,omitempty"`
	// MacOS is the oldest macOS the library runs on, when it needs a later
	// one than the app's minimum or 12.0, as "13.0".
	MacOS string `json:"macOS,omitempty"`
}

// MinMacOS returns the macOS a build for an app whose minimum is app ("" is
// 12.0) targets: the later of app's and the library's.
func (b *Build) MinMacOS(app string) string {
	v := app
	if v == "" {
		v = "12.0"
	}
	if b != nil && b.MacOS != "" && versionLess(v, b.MacOS) {
		return b.MacOS
	}
	return v
}

// versionLess reports whether the version a is older than b, as 12.0 than
// 13.0 and 13.2 than 13.10.
func versionLess(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(as), len(bs)) {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// Skipped reports whether a file or directory of a library's sources is
// left out of them: hidden ones, and those cargo, zig and npm write
// (target, zig-out, zig-cache, zig-pkg, node_modules).
func Skipped(name string) bool {
	switch name {
	case "target", "zig-out", "zig-cache", "zig-pkg", "node_modules":
		return true
	}
	return strings.HasPrefix(name, ".")
}

// SourceHash returns the hash of the sources of a library built in dir
// (the build's directory), which its arguments and macOS version are part
// of: the SHA-256 of the paths and contents of its files, but Skipped
// ones, with line endings as LF, so that checkouts on every platform agree.
func SourceHash(dir string, b *Build) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "%q %q\n", b.Args, b.MacOS)
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != dir && Skipped(d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
		fmt.Fprintf(h, "%s\n%d\n", filepath.ToSlash(rel), len(data))
		h.Write(data)
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Tool returns the build's tool, "cargo", "zig" or "swift", and its
// directory.
func (b *Build) Tool() (tool, dir string) {
	switch {
	case b.Cargo != "":
		return "cargo", b.Cargo
	case b.Swift != "":
		return "swift", b.Swift
	}
	return "zig", b.Zig
}

// IsSwift reports whether the library builds with Swift.
func (b *Build) IsSwift() bool { return b != nil && b.Swift != "" }

// File is a published build of a library.
type File struct {
	Name   string `json:"name"`
	URL    string `json:"url,omitempty"`
	SHA256 string `json:"sha256"`
	// SourceHash is the hash of the sources the file was built from (see
	// SourceHash): the CLI builds the library of a local package from its
	// sources only when they changed since, so that the package's own
	// published files serve it until then, without Rust or Zig.
	SourceHash string `json:"sourceHash,omitempty"`
}

// libraryName is what a library's name may be, as it names files and an
// environment variable.
var libraryName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*$`)

var macOSVersion = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,2}$`)

// Targets are the platforms MyGo builds libraries for, as GOOS-GOARCH.
var Targets = []string{"darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"}

// Parse reads and checks a manifest.
func Parse(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return m, err
	}
	seen := map[string]bool{}
	for _, l := range m.Libraries {
		if !libraryName.MatchString(l.Name) {
			return m, fmt.Errorf("invalid library name %q: use letters, digits, -, _ and .", l.Name)
		}
		if seen[l.Name] {
			return m, fmt.Errorf("library %s is named twice", l.Name)
		}
		seen[l.Name] = true
		if b := l.Build; b != nil {
			if n := btoi(b.Cargo != "") + btoi(b.Zig != "") + btoi(b.Swift != ""); n != 1 {
				return m, fmt.Errorf("library %s: build needs one of cargo, zig and swift", l.Name)
			}
			if _, dir := b.Tool(); filepath.IsAbs(dir) || !filepath.IsLocal(filepath.FromSlash(dir)) {
				return m, fmt.Errorf("library %s: the build's directory %q is not inside the package", l.Name, dir)
			}
			if b.MacOS != "" && !macOSVersion.MatchString(b.MacOS) {
				return m, fmt.Errorf("library %s: invalid macOS version %q, want one as \"13.0\"", l.Name, b.MacOS)
			}
		}
		for target, f := range l.Files {
			if err := f.Check(); err != nil {
				return m, fmt.Errorf("library %s, %s: %w", l.Name, target, err)
			}
		}
	}
	return m, nil
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Lookup returns the library named name.
func (m Manifest) Lookup(name string) (Library, bool) {
	for _, l := range m.Libraries {
		if l.Name == name {
			return l, true
		}
	}
	return Library{}, false
}

// Check checks that the file's name and SHA-256 can be parts of a path: a
// package may not name another file than the library it downloads.
func (f File) Check() error {
	sum, err := hex.DecodeString(f.SHA256)
	if err != nil || len(sum) != sha256.Size || f.SHA256 != strings.ToLower(f.SHA256) {
		return fmt.Errorf("invalid SHA-256 %q", f.SHA256)
	}
	if !validName(f.Name) {
		return fmt.Errorf("invalid file name %q", f.Name)
	}
	return nil
}

func validName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, `/\:`)
}

// FileName returns the file of the library named name on goos when no
// published file names another: lib<name>.dylib, lib<name>.so and
// <name>.dll, as cargo and zig build them.
func FileName(name, goos string) string {
	base := strings.TrimPrefix(name, "lib")
	switch goos {
	case "darwin":
		return "lib" + base + ".dylib"
	case "windows":
		return base + ".dll"
	default:
		return "lib" + base + ".so"
	}
}

// FileName returns the library's file on goos/goarch.
func (l Library) FileName(goos, goarch string) string {
	if f, ok := l.Files[goos+"-"+goarch]; ok {
		return f.Name
	}
	return FileName(l.Name, goos)
}

// Ext returns the extension of dynamic libraries on goos.
func Ext(goos string) string {
	switch goos {
	case "darwin":
		return ".dylib"
	case "windows":
		return ".dll"
	default:
		return ".so"
	}
}

// LocalDir returns where the CLI puts the libraries it builds from sources
// in the module at root for goos/goarch, which programs that are not
// packaged apps look into too: <root>/.mygo/native/<goos>-<goarch>.
func LocalDir(root, goos, goarch string) string {
	return filepath.Join(root, ".mygo", "native", goos+"-"+goarch)
}

// ModuleRoot returns the directory of the go.mod that dir is in.
func ModuleRoot(dir string) (string, error) {
	// A relative dir would stop at the working directory.
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for d := abs; ; {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d, nil
		}
		parent := filepath.Dir(d)
		if parent == d {
			return "", errors.New(dir + " is not in a Go module")
		}
		d = parent
	}
}

// CachePath returns where a published file is kept in the user's cache:
// <cache>/mygo/natives/<sha256>/<name>.
func CachePath(f File) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "mygo", "natives", f.SHA256, f.Name), nil
}
