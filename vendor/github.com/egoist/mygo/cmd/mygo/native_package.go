package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/internal/nativegen"
)

// writeNativePackage writes .mygo/native/Package.swift: the app's native
// modules as the targets of one Swift package, each depending on the
// modules its Go package uses and on what its own Package.swift declares,
// to open in Xcode or point SourceKit-LSP at, which then complete a module
// that uses others. Its targets' sources are links to the modules'. The
// CLI builds each module from its own package, not this one.
func writeNativePackage(c *Config, dirs []string) error {
	type target struct {
		m        *nativegen.Module
		manifest *swiftManifest
	}
	var targets []target
	for _, dir := range dirs {
		if !nativegen.HasLang(dir, "swift") {
			continue
		}
		m, err := nativegen.Load(dir)
		if err != nil {
			return err
		}
		man, err := dumpPackage(filepath.Join(dir, "swift"))
		if err != nil {
			return err
		}
		targets = append(targets, target{m, man})
	}
	if len(targets) == 0 {
		return nil
	}
	root := filepath.Join(c.root, ".mygo", "native")
	if err := os.MkdirAll(filepath.Join(root, "Sources"), 0o755); err != nil {
		return err
	}
	var b bytes.Buffer
	b.WriteString("// swift-tools-version: 6.0\n// Written by mygo: the app's native modules as one package, for Xcode and\n// SourceKit-LSP. Edit the modules' own Package.swift instead.\nimport PackageDescription\n\nlet package = Package(\n    name: \"NativeModules\",\n")
	minimum := "10.15"
	deps := map[string]string{}
	for _, t := range targets {
		for _, p := range t.manifest.Platforms {
			if p.PlatformName == "macos" && compareDotted(p.Version, minimum) > 0 {
				minimum = p.Version
			}
		}
		for _, d := range t.manifest.Dependencies {
			if id, decl := d.decl(); id != "" {
				deps[id] = decl
			}
		}
	}
	fmt.Fprintf(&b, "    platforms: [.macOS(%q)],\n    products: [\n", minimum)
	for _, t := range targets {
		fmt.Fprintf(&b, "        .library(name: %q, type: .dynamic, targets: [%q]),\n", t.m.Name, t.m.Name)
	}
	b.WriteString("    ],\n    dependencies: [\n")
	for _, id := range slices.Sorted(maps.Keys(deps)) {
		fmt.Fprintf(&b, "        %s,\n", deps[id])
	}
	b.WriteString("    ],\n    targets: [\n")
	for _, t := range targets {
		var tdeps []string
		for _, path := range slices.Sorted(maps.Keys(t.m.Deps)) {
			tdeps = append(tdeps, strconv.Quote(t.m.Deps[path].Name))
		}
		var linker []string
		if mt := t.manifest.target(t.m.Name); mt != nil {
			for _, d := range mt.Dependencies {
				if s := d.decl(); s != "" {
					tdeps = append(tdeps, s)
				}
			}
			for _, s := range mt.Settings {
				if s.Tool != "linker" {
					continue
				}
				if f, ok := s.Kind["linkedFramework"]; ok {
					linker = append(linker, fmt.Sprintf(".linkedFramework(%q)", f["_0"]))
				}
				if l, ok := s.Kind["linkedLibrary"]; ok {
					linker = append(linker, fmt.Sprintf(".linkedLibrary(%q)", l["_0"]))
				}
			}
		}
		fmt.Fprintf(&b, "        .target(name: %q, dependencies: [%s], path: \"Sources/%s\"", t.m.Name, strings.Join(tdeps, ", "), t.m.Name)
		if len(linker) > 0 {
			fmt.Fprintf(&b, ", linkerSettings: [%s]", strings.Join(linker, ", "))
		}
		b.WriteString("),\n")
		link := filepath.Join(root, "Sources", t.m.Name)
		want := nativegen.SwiftDir(t.m)
		if old, err := os.Readlink(link); err != nil || old != want {
			os.RemoveAll(link)
			if err := os.Symlink(want, link); err != nil {
				return err
			}
		}
	}
	b.WriteString("    ],\n    swiftLanguageModes: [.v5]\n)\n")
	path := filepath.Join(root, "Package.swift")
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, b.Bytes()) {
		return nil
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}

// swiftManifest is the part of `swift package dump-package` that the
// package of the app's modules takes.
type swiftManifest struct {
	Platforms []struct {
		PlatformName string `json:"platformName"`
		Version      string `json:"version"`
	} `json:"platforms"`
	Dependencies []packageDep     `json:"dependencies"`
	Targets      []manifestTarget `json:"targets"`
}

type manifestTarget struct {
	Name         string      `json:"name"`
	Dependencies []targetDep `json:"dependencies"`
	Settings     []struct {
		Tool string                       `json:"tool"`
		Kind map[string]map[string]string `json:"kind"`
	} `json:"settings"`
}

func (m *swiftManifest) target(name string) *manifestTarget {
	for i := range m.Targets {
		if m.Targets[i].Name == name {
			return &m.Targets[i]
		}
	}
	return nil
}

type packageDep struct {
	SourceControl []struct {
		Identity string `json:"identity"`
		Location struct {
			Remote []struct {
				URLString string `json:"urlString"`
			} `json:"remote"`
		} `json:"location"`
		Requirement map[string]json.RawMessage `json:"requirement"`
	} `json:"sourceControl"`
	FileSystem []struct {
		Identity string `json:"identity"`
		Path     string `json:"path"`
	} `json:"fileSystem"`
}

// decl returns the dependency's identity and its declaration in a
// manifest, or "" for one it cannot say.
func (d packageDep) decl() (string, string) {
	if len(d.FileSystem) > 0 {
		f := d.FileSystem[0]
		return f.Identity, fmt.Sprintf(".package(path: %q)", f.Path)
	}
	if len(d.SourceControl) == 0 || len(d.SourceControl[0].Location.Remote) == 0 {
		return "", ""
	}
	s := d.SourceControl[0]
	url := s.Location.Remote[0].URLString
	for kind, raw := range s.Requirement {
		switch kind {
		case "range":
			var r []struct{ LowerBound, UpperBound string }
			if json.Unmarshal(raw, &r) == nil && len(r) > 0 {
				return s.Identity, fmt.Sprintf(".package(url: %q, %q..<%q)", url, r[0].LowerBound, r[0].UpperBound)
			}
		case "exact", "branch", "revision":
			var v []string
			if json.Unmarshal(raw, &v) == nil && len(v) > 0 {
				return s.Identity, fmt.Sprintf(".package(url: %q, %s: %q)", url, kind, v[0])
			}
		}
	}
	return "", ""
}

// targetDep is a dependency of a target: a product, or one by name.
type targetDep struct {
	Product []*string `json:"product"`
	ByName  []*string `json:"byName"`
}

func (d targetDep) decl() string {
	switch {
	case len(d.Product) >= 2 && d.Product[0] != nil && d.Product[1] != nil:
		return fmt.Sprintf(".product(name: %q, package: %q)", *d.Product[0], *d.Product[1])
	case len(d.ByName) >= 1 && d.ByName[0] != nil:
		return strconv.Quote(*d.ByName[0])
	}
	return ""
}

func dumpPackage(dir string) (*swiftManifest, error) {
	out, err := exec.Command("swift", "package", "dump-package", "--package-path", dir).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("swift package dump-package %s: %v\n%s", dir, err, ee.Stderr)
		}
		return nil, err
	}
	var m swiftManifest
	if err := json.Unmarshal(out, &m); err != nil {
		return nil, fmt.Errorf("swift package dump-package %s: %w", dir, err)
	}
	return &m, nil
}

// compareDotted compares versions such as 13.0 and 10.15.
func compareDotted(a, b string) int {
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
			return x - y
		}
	}
	return 0
}
