package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	fetch "github.com/egoist/mygo/internal/download"
	"github.com/egoist/mygo/internal/nativegen"
	"github.com/egoist/mygo/internal/nativelib"
)

// pluginFile is what a Go package that binds native libraries tells the
// CLI, next to its sources: the libraries it needs, which the apps whose
// packages include it ship among their resources (see
// internal/nativelib). A library is built from its sources (a Rust crate,
// a Zig package) when the package is the app's own or otherwise outside the
// module cache and says how; otherwise its published build for the
// platform is downloaded once per user. The terminal plugin names
// libghostty-vt so:
//
//	{"libraries": [{"name": "libghostty-vt", "files": {
//		"darwin-arm64": {"name": "libghostty-vt.dylib", "url": "https://…", "sha256": "…"},
//		…
//	}}]}
//
// with a file per platform (GOOS-GOARCH), which the package loads from
// mygo.PathResources at run time.
const pluginFile = nativelib.ManifestFile

// appResources lists the resources of the app for goos/goarch (see
// resources), with the native libraries its packages need.
func (c *Config) appResources(goos, goarch string) ([]resource, error) {
	natives, err := c.natives(goos, goarch)
	if err != nil {
		return nil, err
	}
	return c.resourcesWith(goos, goarch, natives, reservedNames(c, goos)...)
}

// natives returns the native libraries the packages of the app for
// goos/goarch name in their mygo-plugin.json, downloaded into the user's
// cache, as resources: both architectures of a universal macOS app, which
// combine into one file.
func (c *Config) natives(goos, goarch string) ([]source, error) {
	pkgs, err := c.nativePackages(goos, goarch)
	if err != nil {
		return nil, err
	}
	return c.nativesOf(pkgs, goos, goarch)
}

// nativesOf returns the native libraries of pkgs for goos/goarch, as
// natives: those of native modules in the language that implements them
// there, but Swift.
func (c *Config) nativesOf(pkgs []nativePackage, goos, goarch string) ([]source, error) {
	var list []source
	seen := map[string]bool{}
	for _, p := range pkgs {
		for _, l := range p.manifest.Libraries {
			l = p.library(l, goos, "")
			if seen[l.Name] || l.Build.IsSwift() || p.isModule(l) && l.Build == nil {
				// Swift libraries go into Frameworks (prepareNative), and
				// a module no language implements here is unsupported.
				continue
			}
			seen[l.Name] = true
			pick := func(goarch string) (string, string, error) {
				target := goos + "-" + goarch
				name := l.FileName(goos, goarch)
				f, ok := l.Files[target]
				if p.builds(l, f, ok) {
					path, err := buildNative(p.dir, l, goos, goarch, c.MacOS.MinimumSystemVersion)
					return name, path, err
				}
				if !ok {
					return "", "", fmt.Errorf("%s needs %s, which has no build for %s", p.dir, l.Name, strings.Replace(target, "-", "/", 1))
				}
				path, err := fetchNative(f)
				return f.Name, path, err
			}
			if goarch == "universal" {
				name, arm, err := pick("arm64")
				if err != nil {
					return nil, err
				}
				amdName, amd, err := pick("amd64")
				if err != nil {
					return nil, err
				}
				if amdName != name {
					return nil, fmt.Errorf("%s: %s is %s on arm64 but %s on amd64", filepath.Join(p.dir, pluginFile), l.Name, name, amdName)
				}
				list = append(list, source{name: name, path: arm, amd64: amd, listed: true})
				continue
			}
			name, path, err := pick(goarch)
			if err != nil {
				return nil, err
			}
			list = append(list, source{name: name, path: path, listed: true})
		}
	}
	return list, nil
}

// nativePackage is a package that names native libraries.
type nativePackage struct {
	dir      string
	manifest nativelib.Manifest
	// local is whether the package is outside the module cache: the app's
	// own, or a module it replaces with a directory, whose libraries are
	// built from their sources.
	local bool
	// module is the native module the package is, whose library its
	// manifest names (see library).
	module *nativegen.Module
}

// builds reports whether the CLI builds l for a platform from its sources
// rather than use its published file f, which ok says there is: when the
// package is local, its sources are there (vendoring copies no more than
// the package's directory) and are not those f was built from, and their
// tool is installed or there is nothing to use instead.
func (p nativePackage) builds(l nativelib.Library, f nativelib.File, ok bool) bool {
	if l.Build == nil || !p.local {
		return false
	}
	tool, dir := l.Build.Tool()
	src := filepath.Join(p.dir, filepath.FromSlash(dir))
	if _, err := os.Stat(src); err != nil {
		return false
	}
	if !ok {
		return true
	}
	if f.SourceHash != "" {
		if h, err := nativelib.SourceHash(src, l.Build); err == nil && h == f.SourceHash {
			return false
		}
	}
	if _, err := exec.LookPath(tool); err != nil {
		logf("%s is not installed: %s gets the published build of %s, not one of its sources", tool, filepath.Base(p.dir), l.Name)
		return false
	}
	return true
}

// nativePackages returns the packages of the app for goos/goarch that name
// native libraries.
func (c *Config) nativePackages(goos, goarch string) ([]nativePackage, error) {
	dirs, err := c.packageDirs(goos, goarch)
	if err != nil {
		return nil, err
	}
	return readNativePackages(dirs)
}

// packageDirs returns the directories of the packages, outside the
// standard library, that the app for goos/goarch is built from, listed
// once per build (Config.deps).
func (c *Config) packageDirs(goos, goarch string) ([]string, error) {
	arch := goarch
	if goarch == "universal" {
		arch = "arm64" // the packages are the same
	}
	key := goos + "/" + arch
	if dirs, ok := c.deps[key]; ok {
		return dirs, nil
	}
	var out, stderr bytes.Buffer
	cmd := goCommand(c.root, []string{"GOOS=" + goos, "GOARCH=" + arch}, "list", "-e", "-deps", "-f", "{{if not .Standard}}{{.Dir}}{{end}}", c.Main)
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("go list: %v\n%s", err, strings.TrimSpace(stderr.String()))
	}
	dirs := strings.Fields(out.String())
	if c.deps == nil {
		c.deps = map[string][]string{}
	}
	c.deps[key] = dirs
	return dirs, nil
}

// readNativePackages reads the manifests of the packages in dirs, and
// the native modules among them, whose library their manifest names when
// it does not.
func readNativePackages(dirs []string) ([]nativePackage, error) {
	var list []nativePackage
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		man, ok, err := readManifest(dir)
		if err != nil {
			return nil, err
		}
		p := nativePackage{dir: dir, manifest: man, local: isLocalPackage(dir)}
		if nativegen.IsModule(dir) {
			m, err := nativegen.Load(dir)
			if err != nil {
				return nil, err
			}
			if err := addModuleLibrary(&p.manifest, m); err != nil {
				return nil, err
			}
			p.module = m
		} else if !ok {
			continue
		}
		list = append(list, p)
	}
	return list, nil
}

// fetchNative returns the path of a native library in the user's cache,
// downloading it there first when it is missing:
// <cache>/mygo/natives/<sha256>/<name>, where the packages that load it
// look too when they run outside an app built by the CLI.
func fetchNative(f nativelib.File) (string, error) {
	if err := f.Check(); err != nil {
		return "", fmt.Errorf("invalid native library %+v: %w", f, err)
	}
	path, err := nativelib.CachePath(f)
	if err != nil {
		return "", err
	}
	// What the app ships must be what the package names.
	if fetch.Check(path, f.SHA256) {
		return path, nil
	}
	if f.URL == "" {
		return "", fmt.Errorf("%s is not published yet: its package publishes it with mygo native build", f.Name)
	}
	t := con.start("Downloading " + f.Name)
	err = fetch.Cached(context.Background(), downloadFile(t, f.URL, f.SHA256), path)
	if t.end(err, "Downloaded "+f.Name) != nil {
		return "", fmt.Errorf("downloading %s from %s: %w", f.Name, f.URL, err)
	}
	return path, nil
}
