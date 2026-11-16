package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	fetch "github.com/egoist/mygo/internal/download"
	"github.com/egoist/mygo/internal/nativegen"
	"github.com/egoist/mygo/internal/nativelib"
)

const nativeBuildUsage = `Usage: mygo native build [flags] [dir]

Builds the native libraries that the packages in dir (default ".") name
in their mygo-plugin.json from their sources (a Rust crate with cargo, a
Zig package with zig build) for every platform, and writes the published
builds into mygo-plugin.json: their names, SHA-256 and URLs under the
library's release. The files to publish go into .mygo/native/release of
the module, named after their SHA-256 so that a release never replaces a
file that published versions point at; -upload publishes them as the
assets of a GitHub release, before writing mygo-plugin.json.

Platforms that do not build here are reported, and left as they are in
mygo-plugin.json: Rust libraries for macOS build on a Mac only, so build
them there with -target darwin-arm64,darwin-amd64, and the others
elsewhere; each run adds its platforms to the manifest.

Each file records the hash of the sources it was built from: platforms
whose files were built from the sources as they are are skipped (-force
builds them again), and mygo dev and mygo build use those files instead of
building the library, which they do once its sources changed.

mygo dev and mygo build build the libraries of the app's own packages
themselves; apps that use a package from the module cache download its
published builds instead, so they need neither Rust nor Zig.

With -target host, it builds this machine's library only, for go run and
go test, which find it in .mygo/native/<goos>-<goarch> of the module, and
leaves mygo-plugin.json alone.
`

// runNativeBuild runs mygo native build, with the arguments after build.
func runNativeBuild(args []string) error {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
		fmt.Print(nativeBuildUsage)
		return nil
	}
	flags := newFlags("native build", "[dir]", "Builds the native libraries of the packages in dir for every platform, ready to publish.")
	target := flags.String("target", "all", `the platforms, GOOS-GOARCH separated by commas, "all" or "host"`)
	release := flags.String("release", "", "the URL the files are published under, as https://github.com/<owner>/<repo>/releases/download/<tag>\n(default: the library's release in mygo-plugin.json)")
	out := flags.String("out", "", "the directory of the files to publish (default: .mygo/native/release in the module)")
	upload := flags.Bool("upload", false, "upload the files to the GitHub release of -release with the GitHub CLI")
	force := flags.Bool("force", false, "build the platforms whose published files were built from these sources too")
	lang := flags.String("lang", "", "build native modules in this language (swift, rust or zig) where they are\nimplemented in it, rather than in each platform's: to test each with -target host")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() > 1 {
		return fmt.Errorf("unexpected arguments %q: flags go before the directory (mygo native build [flags] [dir])", flags.Args()[1:])
	}
	dir, err := filepath.Abs(dirArg(flags.Args()))
	if err != nil {
		return err
	}
	targets, err := nativeTargets(*target)
	if err != nil {
		return err
	}
	host := *target == "host"
	if host && *upload {
		return errors.New("-upload publishes the builds of every platform: leave -target out")
	}
	pkgs, err := nativePackagesIn(dir)
	if err != nil {
		return err
	}
	var libs []*nativelib.Library
	for _, p := range pkgs {
		for i := range p.manifest.Libraries {
			if l := &p.manifest.Libraries[i]; l.Build != nil || p.isModule(*l) {
				if *upload && *release == "" && l.Release == "" {
					// The library's own release in the repository.
					repo, err := gitHubRepo(p.dir)
					if err != nil {
						return fmt.Errorf("-upload: %s has no release: %w", l.Name, err)
					}
					l.Release = "https://github.com/" + repo + "/releases/download/" + defaultReleaseTag(l.Name)
				}
				libs = append(libs, l)
			}
		}
	}
	if len(libs) == 0 {
		return fmt.Errorf("%s is no native module, nor does a %s in it name a library to build (\"build\": {\"cargo\": \"./<dir>\"}, {\"zig\": \"./<dir>\"} or {\"swift\": \"./<dir>\"})", dir, pluginFile)
	}
	if !host {
		warnNativeRelease(pkgs, targets)
	}

	// Build every platform that builds here, then publish them, and only
	// then name them in the manifests, so that these never point at files
	// that are not there.
	var assets, failed []string
	uploads := map[string][]string{} // the files of each release
	changed := map[string]bool{}     // the packages whose manifest to write
	// publish builds library l of package p for targets, and publishes it
	// under release r. It stops at the first build that fails, but lists
	// in failed, without host, the platforms that build only on another
	// system, such as Swift's off a Mac.
	publish := func(p nativePackage, l *nativelib.Library, targets []string, r string) error {
		if l.Build.IsSwift() {
			a, err := publishSwift(p, l, targets, host, *force, *out, r)
			switch {
			case err != nil && (host || !buildsElsewhere(err)):
				return fmt.Errorf("%s: %w", l.Name, err)
			case err != nil:
				failed = append(failed, fmt.Sprintf("%s: %v", l.Name, err))
			case a != "":
				assets = append(assets, a)
				if r != "" {
					uploads[r] = append(uploads[r], a)
				}
				l.Release = r
				changed[p.dir] = true
			}
			return nil
		}
		_, d := l.Build.Tool()
		src := filepath.Join(p.dir, filepath.FromSlash(d))
		before, err := nativelib.SourceHash(src, l.Build)
		if err != nil {
			return err
		}
		built := map[string]bool{} // the platforms this run publishes
		for _, t := range targets {
			goos, goarch, _ := strings.Cut(t, "-")
			if f, ok := l.Files[t]; ok && !host && !*force && f.SourceHash == before {
				logf("%s for %s is published from these sources", l.Name, t)
				continue
			}
			path, err := buildNative(p.dir, *l, goos, goarch, "")
			if err == nil && !host {
				var a string
				var f nativelib.File
				if a, f, err = publishNative(p.dir, *out, *l, path, goos, goarch, r); err == nil {
					if l.Files == nil {
						l.Files = map[string]nativelib.File{}
					}
					l.Files[t] = f
					built[t] = true
					assets = append(assets, a)
					if r != "" {
						uploads[r] = append(uploads[r], a)
					}
				}
			}
			if err != nil {
				if host || !buildsElsewhere(err) {
					return err
				}
				failed = append(failed, fmt.Sprintf("%s for %s: %v", l.Name, t, err))
			}
		}
		if !host {
			// After the builds, which may write into the sources, as
			// cargo its Cargo.lock.
			h, err := nativelib.SourceHash(src, l.Build)
			if err != nil {
				return err
			}
			for t := range built {
				f := l.Files[t]
				f.SourceHash = h
				l.Files[t] = f
			}
			l.Release = r
			changed[p.dir] = true
		}
		return nil
	}
	for _, p := range pkgs {
		if p.module != nil {
			if _, err := nativegen.Generate(p.dir); err != nil {
				return err
			}
		}
		for i := range p.manifest.Libraries {
			l := &p.manifest.Libraries[i]
			r := cmp.Or(*release, l.Release)
			if !p.isModule(*l) {
				if l.Build != nil {
					if err := publish(p, l, targets, r); err != nil {
						return err
					}
				}
				continue
			}
			// A native module builds in the language of each platform.
			by := moduleTargets(p.dir, targets, *lang, host)
			if len(by) == 0 {
				err := fmt.Errorf("native module %s has no implementation for %s", l.Name, strings.Join(targets, ", "))
				if host || *lang != "" {
					return err
				}
				logf("%v", err)
			}
			for _, lg := range nativegen.Langs {
				ts, ok := by[lg]
				if !ok {
					continue
				}
				l.Build = langBuild(lg)
				err := publish(p, l, ts, r)
				l.Build = nil
				if err != nil {
					return err
				}
				if !host && slices.ContainsFunc(ts, func(t string) bool { return strings.HasPrefix(t, "darwin-") }) {
					dropStaleDarwin(l, lg == "swift")
				}
			}
		}
	}
	if host {
		return nil
	}
	if len(assets) > 0 && *upload {
		for r, files := range uploads {
			if err := uploadNatives(r, files); err != nil {
				return fmt.Errorf("%w\n%s is unchanged", err, pluginFile)
			}
		}
	}
	for _, p := range pkgs {
		if !changed[p.dir] || len(assets) == 0 {
			continue
		}
		if err := writeManifest(filepath.Join(p.dir, pluginFile), p.manifest); err != nil {
			return err
		}
		logf("Wrote %s", cyan(filepath.Join(p.dir, pluginFile)))
	}
	for _, l := range libs {
		if l.Release == "" && len(assets) > 0 {
			logf("%s has no release: set it with -release so that apps can download its files", l.Name)
		}
	}
	if len(assets) > 0 && !*upload {
		logf("Publish %s under the release of each library, or run again with -upload", cyan(filepath.Dir(assets[0])))
	}
	if len(failed) > 0 {
		return fmt.Errorf("not built, and left as they were in %s:\n%s", pluginFile, strings.Join(failed, "\n\n"))
	}
	return nil
}

// warnNativeRelease warns of what makes published libraries load on fewer
// systems than they could, or a module that would commit the builds.
func warnNativeRelease(pkgs []nativePackage, targets []string) {
	linux := slices.ContainsFunc(targets, func(t string) bool { return strings.HasPrefix(t, "linux-") })
	roots := map[string]bool{}
	for _, p := range pkgs {
		for _, l := range p.manifest.Libraries {
			if l = p.library(l, "linux", ""); l.Build == nil {
				continue
			}
			if tool, _ := l.Build.Tool(); tool == "cargo" && linux && !zigbuild("linux", "amd64") {
				logf("Without cargo-zigbuild (and Zig), %s's Linux libraries need the glibc of this machine or later: cargo install cargo-zigbuild", l.Name)
				linux = false
			}
		}
		root, err := nativelib.ModuleRoot(p.dir)
		if err != nil || roots[root] {
			continue
		}
		roots[root] = true
		data, _ := os.ReadFile(filepath.Join(root, ".gitignore"))
		if !strings.Contains(string(data), ".mygo") {
			logf("Add .mygo/ to %s: the builds go into %s", filepath.Join(root, ".gitignore"), filepath.Join(root, ".mygo"))
		}
	}
}

// nativeTargets returns the platforms -target names.
func nativeTargets(s string) ([]string, error) {
	switch s {
	case "all", "":
		return nativelib.Targets, nil
	case "host":
		return []string{runtime.GOOS + "-" + runtime.GOARCH}, nil
	}
	list := splitList(s)
	for _, t := range list {
		if !slices.Contains(nativelib.Targets, t) {
			return nil, fmt.Errorf("-target: unknown platform %q, want one of %s", t, strings.Join(nativelib.Targets, ", "))
		}
	}
	return list, nil
}

// nativePackagesIn returns the package in dir when it names native
// libraries or is a native module, or else the packages under dir that
// are.
func nativePackagesIn(dir string) ([]nativePackage, error) {
	dirs := []string{dir}
	if _, err := os.Stat(filepath.Join(dir, pluginFile)); err != nil && !nativegen.IsModule(dir) {
		var out, stderr bytes.Buffer
		cmd := goCommand(dir, nil, "list", "-e", "-f", "{{.Dir}}", "./...")
		cmd.Stdout, cmd.Stderr = &out, &stderr
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("go list: %v\n%s", err, strings.TrimSpace(stderr.String()))
		}
		dirs = strings.Fields(out.String())
	}
	return readNativePackages(dirs)
}

// dropStaleDarwin removes the macOS files of native module l that its
// language there no longer publishes, once the new ones are there: the
// universal build of Swift (swift false) or the two of Rust and Zig.
func dropStaleDarwin(l *nativelib.Library, swift bool) {
	_, arm := l.Files["darwin-arm64"]
	_, amd := l.Files["darwin-amd64"]
	_, universal := l.Files[nativelib.Universal]
	switch {
	case swift && universal:
		delete(l.Files, "darwin-arm64")
		delete(l.Files, "darwin-amd64")
	case !swift && arm && amd:
		delete(l.Files, nativelib.Universal)
	}
}

// moduleTargets returns the platforms among targets that each language
// of the native module in dir builds for (moduleLang), or lang alone. For
// this machine only (host), Swift serves Linux when nothing else does, for
// go test and go run.
func moduleTargets(dir string, targets []string, lang string, host bool) map[string][]string {
	by := map[string][]string{}
	for _, t := range targets {
		goos, _, _ := strings.Cut(t, "-")
		l := moduleLang(dir, goos, lang)
		if l == "" && host && goos == "linux" {
			l = moduleLang(dir, goos, "swift")
		}
		if l != "" {
			by[l] = append(by[l], t)
		}
	}
	return by
}

// defaultReleaseTag is the release that mygo native build -upload uploads
// library name to without -release or a library's release: one per
// library, as native-sqlitecore, which every build of it goes to, so
// that publishing makes no release, nor tag, per change.
func defaultReleaseTag(name string) string {
	return "native-" + strings.ToLower(name)
}

// publishSwift builds the Swift library l of package p, universal, when
// targets include macOS and its published build is not of its sources (or
// force), packs it with the frameworks it brings into the directory of the
// files to publish (out), named after its SHA-256, records it in l.Files
// under nativelib.Universal, and returns it. With host, it builds the
// debug build of this Mac for go run and go test instead, and records
// nothing. It returns "" when there is nothing to publish.
func publishSwift(p nativePackage, l *nativelib.Library, targets []string, host, force bool, out, release string) (string, error) {
	if !host && !slices.ContainsFunc(targets, func(t string) bool { return strings.HasPrefix(t, "darwin-") }) {
		return "", nil
	}
	m := p.module
	if host && runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return "", errSwiftMacOnly // Linux builds one for go test and go run
	}
	if host {
		if m != nil {
			_, err := buildSwiftModule(p.dir, runtime.GOARCH, false)
			return "", err
		}
		_, err := buildSwiftLibrary(p.dir, *l, runtime.GOARCH, false)
		return "", err
	}
	hash, err := swiftSourceHash(p.dir, *l, m)
	if err != nil {
		return "", err
	}
	if f, ok := l.Files[nativelib.Universal]; ok && !force && f.SourceHash == hash {
		logf("%s for %s is published from these sources", l.Name, nativelib.Universal)
		return "", nil
	}
	if runtime.GOOS != "darwin" {
		return "", errSwiftMacOnly
	}
	var b nativeBuild
	if m != nil {
		b, err = buildSwiftModule(p.dir, "universal", true)
	} else {
		b, err = buildSwiftLibrary(p.dir, *l, "universal", true)
	}
	if err != nil {
		return "", err
	}
	if out == "" {
		root, err := nativelib.ModuleRoot(p.dir)
		if err != nil {
			return "", err
		}
		out = filepath.Join(root, ".mygo", "native", "release")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return "", err
	}
	packed := filepath.Join(out, l.Name+"-packing.tar.gz")
	defer os.Remove(packed)
	if err := tarDir(packed, append([]string{b.dylib}, b.frameworks...)); err != nil {
		return "", err
	}
	sum, err := fetch.FileSHA256(packed)
	if err != nil {
		return "", err
	}
	// The SHA-256 is part of the name, as publishNative's.
	prefix := filepath.Join(out, l.Name+"-"+nativelib.Universal+"-")
	asset := prefix + sum[:12] + ".tar.gz"
	old, _ := filepath.Glob(prefix + "*.tar.gz")
	for _, f := range old {
		if f != asset {
			os.Remove(f)
		}
	}
	if err := os.Rename(packed, asset); err != nil {
		return "", err
	}
	f := nativelib.File{Name: l.Name + "-" + nativelib.Universal + ".tar.gz", SHA256: sum, SourceHash: hash}
	if release != "" {
		f.URL = strings.TrimSuffix(release, "/") + "/" + filepath.Base(asset)
	}
	if cached, err := nativelib.CachePath(f); err == nil && !fetch.Check(cached, sum) {
		if err := replaceFile(asset, cached); err != nil {
			return "", err
		}
	}
	if l.Files == nil {
		l.Files = map[string]nativelib.File{}
	}
	l.Files[nativelib.Universal] = f
	return asset, nil
}

// publishNative copies a library built for goos/goarch into the directory
// of the files to publish, as <name>-<goos>-<goarch>-<sha256[:12]><ext>,
// and into the
// user's cache, where apps on this machine find it before it is published,
// and returns the copy and its entry in the manifest.
func publishNative(dir, out string, l nativelib.Library, built, goos, goarch, release string) (string, nativelib.File, error) {
	if out == "" {
		root, err := nativelib.ModuleRoot(dir)
		if err != nil {
			return "", nativelib.File{}, err
		}
		out = filepath.Join(root, ".mygo", "native", "release")
	}
	// The SHA-256 is part of the name: a release never gets another file
	// under a name that published versions of the package point at.
	sum, err := fetch.FileSHA256(built)
	if err != nil {
		return "", nativelib.File{}, err
	}
	prefix := filepath.Join(out, l.Name+"-"+goos+"-"+goarch+"-")
	asset := prefix + sum[:12] + nativelib.Ext(goos)
	// Earlier builds would be published again with this one.
	old, _ := filepath.Glob(prefix + "*" + nativelib.Ext(goos))
	for _, f := range old {
		if f != asset {
			os.Remove(f)
		}
	}
	if err := replaceFile(built, asset); err != nil {
		return "", nativelib.File{}, err
	}
	f := nativelib.File{Name: l.FileName(goos, goarch), SHA256: sum}
	if release != "" {
		f.URL = strings.TrimSuffix(release, "/") + "/" + filepath.Base(asset)
	}
	cached, err := nativelib.CachePath(f)
	if err == nil && !fetch.Check(cached, sum) {
		err = replaceFile(asset, cached)
	}
	return asset, f, err
}

// writeManifest writes a package's mygo-plugin.json.
func writeManifest(path string, m nativelib.Manifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// githubRelease returns the repository and the tag of a GitHub release's
// download URL: https://github.com/<owner>/<repo>/releases/download/<tag>.
func githubRelease(release string) (repo, tag string, err error) {
	u, err := url.Parse(release)
	var parts []string
	if err == nil {
		parts = strings.Split(strings.Trim(u.Path, "/"), "/")
	}
	if err != nil || u.Host != "github.com" || len(parts) != 5 || parts[2] != "releases" || parts[3] != "download" {
		return "", "", fmt.Errorf("-upload needs the release of a GitHub repository, https://github.com/<owner>/<repo>/releases/download/<tag>, not %q", release)
	}
	return parts[0] + "/" + parts[1], parts[4], nil
}

// uploadNatives uploads files to a GitHub release, created if needed (not
// as the repository's latest release, which is its apps'), with the gh CLI.
func uploadNatives(release string, files []string) error {
	repo, tag, err := githubRelease(release)
	if err != nil {
		return err
	}
	gh, err := exec.LookPath("gh")
	if err != nil {
		return errors.New("-upload needs the GitHub CLI (https://cli.github.com), signed in with gh auth login or GH_TOKEN")
	}
	if exec.Command(gh, "release", "view", tag, "--repo", repo).Run() != nil {
		t := con.start("Creating the release " + tag + " of " + repo)
		out, err := exec.Command(gh, "release", "create", tag, "--repo", repo, "--title", tag, "--notes", "Builds of a native module, published by mygo native build -upload.", "--latest=false").CombinedOutput()
		if t.end(err, "Created the release "+tag+" of "+repo) != nil {
			return fmt.Errorf("gh release create: %v\n%s", err, out)
		}
	}
	// The files' names carry their SHA-256: one there already is the same
	// file, which is neither uploaded again nor replaced.
	there, _ := exec.Command(gh, "release", "view", tag, "--repo", repo, "--json", "assets", "--jq", ".assets[].name").Output()
	files = slices.DeleteFunc(slices.Clone(files), func(f string) bool {
		return slices.Contains(strings.Fields(string(there)), filepath.Base(f))
	})
	if len(files) == 0 {
		logf("The files are uploaded already")
		return nil
	}
	slices.Sort(files)
	t := con.start("Uploading " + uploadNames(files))
	out, err := exec.Command(gh, append([]string{"release", "upload", tag, "--repo", repo}, files...)...).CombinedOutput()
	if t.end(err, "Uploaded "+uploadNames(files)) != nil {
		return fmt.Errorf("gh release upload: %v\n%s", err, out)
	}
	return nil
}

// errSwiftMacOnly is the error of a Swift library built off a Mac.
var errSwiftMacOnly = errors.New("Swift libraries build on a Mac, with Xcode or its Command Line Tools")

// buildsElsewhere reports whether err is that of a library that builds only
// on another system, which a build for every platform leaves for that
// system rather than stop at.
func buildsElsewhere(err error) bool {
	return errors.Is(err, errSwiftMacOnly) || errors.Is(err, errMacOSOnly)
}
