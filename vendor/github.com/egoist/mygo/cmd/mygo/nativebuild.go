package main

import (
	"bufio"
	"bytes"
	"cmp"
	"debug/elf"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/egoist/mygo/internal/nativelib"
)

// cargoTriple returns the Rust target of goos/goarch. Windows libraries
// are built with MSVC's toolchain on Windows and with MinGW's elsewhere,
// which cargo-zigbuild provides.
func cargoTriple(goos, goarch string) (string, error) {
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[goarch]
	if arch == "" {
		return "", fmt.Errorf("cannot build native libraries for %s/%s", goos, goarch)
	}
	switch goos {
	case "darwin":
		return arch + "-apple-darwin", nil
	case "linux":
		return arch + "-unknown-linux-gnu", nil
	case "windows":
		if runtime.GOOS == "windows" {
			return arch + "-pc-windows-msvc", nil
		}
		if goarch == "arm64" {
			return "aarch64-pc-windows-gnullvm", nil
		}
		return "x86_64-pc-windows-gnu", nil
	}
	return "", fmt.Errorf("cannot build native libraries for %s/%s", goos, goarch)
}

// zigTriple returns the Zig target of goos/goarch: Linux libraries link
// against the glibc of Debian 10 and Ubuntu 20.04, and run on later ones,
// and macOS libraries on macOS minMacOS and later ("" is 12.0), where Zig
// would otherwise ask for the latest.
func zigTriple(goos, goarch, minMacOS string) (string, error) {
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[goarch]
	switch {
	case arch == "":
	case goos == "darwin":
		return arch + "-macos." + cmp.Or(minMacOS, "12.0"), nil
	case goos == "linux":
		return arch + "-linux-gnu.2.28", nil
	case goos == "windows":
		return arch + "-windows-gnu", nil
	}
	return "", fmt.Errorf("cannot build native libraries for %s/%s", goos, goarch)
}

// buildNative builds lib, which the manifest of the package in dir names,
// from its sources for goos/goarch, and returns the built file, in the
// module's .mygo/native/<goos>-<goarch> (nativelib.LocalDir), where
// programs that are not packaged apps find it too. macOS libraries support
// macOS minMacOS ("" is 12.0) or the library's minimum, the later, and
// later ones. cargo and zig build only what
// changed, so building again is quick.
func buildNative(dir string, lib nativelib.Library, goos, goarch, minMacOS string) (string, error) {
	root, err := nativelib.ModuleRoot(dir)
	if err != nil {
		return "", err
	}
	tool, src := lib.Build.Tool()
	src = filepath.Join(dir, filepath.FromSlash(src))
	minMacOS = lib.Build.MinMacOS(minMacOS)
	t := con.start(fmt.Sprintf("Building %s for %s/%s with %s", lib.Name, goos, goarch, tool))
	var built string
	if tool == "cargo" {
		built, err = buildCargo(root, src, lib, goos, goarch, minMacOS)
	} else {
		built, err = buildZig(root, src, lib, goos, goarch, minMacOS)
	}
	var out string
	if err == nil && goos == "linux" {
		built, err = stripELF(built, filepath.Join(root, ".mygo", "native", "stripped", lib.Name+"-"+goarch+".so"))
	}
	if err == nil {
		out = filepath.Join(nativelib.LocalDir(root, goos, goarch), lib.FileName(goos, goarch))
		err = replaceFile(built, out)
	}
	if t.end(err, fmt.Sprintf("Built %s for %s/%s", lib.Name, goos, goarch)) != nil {
		return "", fmt.Errorf("building %s (%s): %w", lib.Name, filepath.Join(dir, pluginFile), err)
	}
	return out, nil
}

// errMacOSOnly is the error of a Rust library for macOS built elsewhere.
var errMacOSOnly = errors.New("Rust libraries for macOS link with Apple's SDK: build them on a Mac (mygo native build -target darwin-arm64,darwin-amd64)")

// zigbuild reports whether cargo-zigbuild builds Rust libraries for
// goos/goarch: it links Linux libraries against an old glibc, as
// zigTriple, so that they load on older systems than the one building,
// and other platforms' libraries, which cargo alone cannot link, but not
// macOS's, which need Apple's SDK, nor Windows' on Windows, built with
// MSVC.
func zigbuild(goos, goarch string) bool {
	if goos == "darwin" || goos == "windows" && runtime.GOOS == "windows" ||
		goos == runtime.GOOS && goarch == runtime.GOARCH && goos != "linux" {
		return false
	}
	_, err1 := exec.LookPath("cargo-zigbuild")
	_, err2 := exec.LookPath("zig")
	return err1 == nil && err2 == nil
}

// buildCargo builds the cdylib of the crate in src with cargo, or
// cargo-zigbuild (see zigbuild).
func buildCargo(root, src string, lib nativelib.Library, goos, goarch, minMacOS string) (string, error) {
	triple, err := cargoTriple(goos, goarch)
	if err != nil {
		return "", err
	}
	if goos == "darwin" && runtime.GOOS != "darwin" {
		return "", errMacOSOnly
	}
	if _, err := exec.LookPath("cargo"); err != nil {
		return "", errors.New("cargo is not installed: get it from https://rustup.rs")
	}
	cmd, target := "build", triple
	if zigbuild(goos, goarch) {
		cmd = "zigbuild"
		if goos == "linux" {
			target += ".2.28"
		}
	}
	manifest := filepath.Join(src, "Cargo.toml")
	args := []string{cmd, "--lib", "--manifest-path", manifest, "--target", target, "--message-format=json-render-diagnostics"}
	// The release profile, unless the arguments pick another.
	if !slices.ContainsFunc(lib.Build.Args, func(a string) bool {
		return a == "--release" || a == "-r" || a == "--profile" || strings.HasPrefix(a, "--profile=")
	}) {
		args = append(args, "--release")
	}
	args = append(args, lib.Build.Args...)
	c := exec.Command("cargo", args...)
	c.Env = append(os.Environ(), "CARGO_TARGET_DIR="+filepath.Join(root, ".mygo", "native", "cargo"))
	if goos == "darwin" {
		c.Env = append(c.Env, "MACOSX_DEPLOYMENT_TARGET="+cmp.Or(minMacOS, "12.0"))
	}
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	if err := c.Run(); err != nil {
		msg := tail(stderr.String(), 40)
		if strings.Contains(msg, "target may not be installed") {
			msg += "\n\nInstall the target with: rustup target add " + triple
		} else if cmd == "build" && goos != "windows" && (goos != runtime.GOOS || goarch != runtime.GOARCH) {
			msg += "\n\ncargo-zigbuild (cargo install cargo-zigbuild, with Zig) links for other platforms"
		}
		return "", fmt.Errorf("cargo %s: %v\n%s", cmd, err, msg)
	}
	// The messages name what cargo built; the crate's own cdylib is the
	// library.
	want, err := filepath.Abs(manifest)
	if err != nil {
		return "", err
	}
	ext := nativelib.Ext(goos)
	var found string
	sc := bufio.NewScanner(&stdout)
	sc.Buffer(nil, 16<<20)
	for sc.Scan() {
		var m struct {
			Reason       string `json:"reason"`
			ManifestPath string `json:"manifest_path"`
			Target       struct {
				Kind []string `json:"kind"`
			} `json:"target"`
			Filenames []string `json:"filenames"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Reason != "compiler-artifact" || !slices.Contains(m.Target.Kind, "cdylib") || !sameFile(m.ManifestPath, want) {
			continue
		}
		for _, f := range m.Filenames {
			if strings.HasSuffix(f, ext) {
				found = f
			}
		}
	}
	if found == "" {
		return "", fmt.Errorf("%s builds no dynamic library: add crate-type = [\"cdylib\"] under [lib]", manifest)
	}
	return found, nil
}

// buildZig builds the package in src with zig build, which installs the
// library into a prefix of its own.
func buildZig(root, src string, lib nativelib.Library, goos, goarch, minMacOS string) (string, error) {
	triple, err := zigTriple(goos, goarch, minMacOS)
	if err != nil {
		return "", err
	}
	if _, err := exec.LookPath("zig"); err != nil {
		return "", errors.New("zig is not installed: get it from https://ziglang.org/download")
	}
	prefix := filepath.Join(root, ".mygo", "native", "zig", lib.Name, goos+"-"+goarch)
	if err := os.RemoveAll(prefix); err != nil {
		return "", err
	}
	zigCacheTmp()
	args := []string{"build", "-Dtarget=" + triple, "--prefix", prefix, "--cache-dir", filepath.Join(root, ".mygo", "native", "zig-cache")}
	// ReleaseFast, unless the arguments pick another mode.
	if !slices.ContainsFunc(lib.Build.Args, func(a string) bool { return strings.HasPrefix(a, "-Doptimize") }) {
		args = append(args, "-Doptimize=ReleaseFast")
	}
	args = append(args, lib.Build.Args...)
	c := exec.Command("zig", args...)
	c.Dir = src
	var out bytes.Buffer
	c.Stdout, c.Stderr = &out, &out
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("zig build: %v\n%s", err, tail(out.String(), 40))
	}
	// Windows libraries go into bin, beside their import libraries in lib.
	ext, want := nativelib.Ext(goos), lib.FileName(goos, goarch)
	var found []string
	for _, sub := range []string{"lib", "bin"} {
		entries, _ := os.ReadDir(filepath.Join(prefix, sub))
		for _, e := range entries {
			if filepath.Ext(e.Name()) != ext {
				continue
			}
			path := filepath.Join(prefix, sub, e.Name())
			if e.Name() == want {
				return path, nil
			}
			found = append(found, path)
		}
	}
	if len(found) == 1 {
		return found[0], nil
	}
	if len(found) == 0 {
		return "", fmt.Errorf("zig build installed no %s library: add b.installArtifact(b.addLibrary(.{.linkage = .dynamic, ...})) to build.zig", ext)
	}
	return "", fmt.Errorf("zig build installed several libraries and none is %s: %s", want, strings.Join(found, ", "))
}

// zigCacheTmp makes the tmp directory in Zig's global cache. Zig 0.16
// unpacks a .zip dependency through a file it creates there without
// making the directory first, so on a fresh cache, as on a new CI runner,
// the fetch fails with "failed to create temporary zip file: FileNotFound".
// Errors are left for zig build to report.
var zigCacheTmp = sync.OnceFunc(func() {
	out, err := exec.Command("zig", "env").Output()
	if err != nil {
		return
	}
	m := regexp.MustCompile(`\.global_cache_dir = ("(?:[^"\\]|\\.)*")`).FindSubmatch(out)
	if m == nil {
		return
	}
	dir, err := strconv.Unquote(string(m[1]))
	if err != nil || dir == "" {
		return
	}
	_ = os.MkdirAll(filepath.Join(dir, "tmp"), 0o755)
})

// replaceFile copies src, following links, to dst through a temporary file,
// as dst may be loaded by a running program.
func replaceFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	f.Close()
	if err := copyFile(src, tmp, 0o755); err != nil {
		os.Remove(tmp)
		return err
	}
	// CreateTemp made it 0600, which copyFile keeps.
	if err := os.Chmod(tmp, 0o755); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func sameFile(a, b string) bool {
	ia, err := os.Stat(a)
	if err != nil {
		return false
	}
	ib, err := os.Stat(b)
	return err == nil && os.SameFile(ia, ib)
}

// tail returns the last n lines of s.
func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// stripELF writes a copy of the ELF library at path to out without the
// contents of its debug sections, as `strip --strip-debug` would, and
// returns out, or path when it has none: Zig keeps the debug information
// of libraries that ask to be stripped, as Ghostty's, four fifths of them.
// What loading uses (the segments, and the sections in them) stays in
// place; the other sections after the segments move down, and the debug
// sections keep their headers, empty, so that no index changes.
func stripELF(path, out string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	f, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	if f.Class != elf.ELFCLASS64 || f.Data != elf.ELFDATA2LSB {
		return "", fmt.Errorf("%s: not a 64-bit little-endian ELF file", path)
	}
	debug := slices.ContainsFunc(f.Sections, func(s *elf.Section) bool {
		return s.FileSize > 0 && (strings.HasPrefix(s.Name, ".debug") || strings.HasPrefix(s.Name, ".zdebug"))
	})
	if !debug {
		return path, nil
	}
	end := uint64(0)
	for _, p := range f.Progs {
		end = max(end, p.Off+p.Filesz)
	}
	stripped := append([]byte(nil), data[:end]...)
	le := binary.LittleEndian
	shoff := le.Uint64(data[0x28:])
	shentsize, shnum := uint64(le.Uint16(data[0x3a:])), uint64(le.Uint16(data[0x3c:]))
	headers := append([]byte(nil), data[shoff:shoff+shentsize*shnum]...)
	for i, s := range f.Sections {
		h := headers[uint64(i)*shentsize:]
		if s.Type == elf.SHT_NULL || s.Type == elf.SHT_NOBITS || s.Flags&elf.SHF_ALLOC != 0 || s.Offset < end {
			continue
		}
		size := s.FileSize
		if strings.HasPrefix(s.Name, ".debug") || strings.HasPrefix(s.Name, ".zdebug") {
			size = 0
		}
		align := max(s.Addralign, 1)
		for uint64(len(stripped))%align != 0 {
			stripped = append(stripped, 0)
		}
		le.PutUint64(h[0x18:], uint64(len(stripped))) // sh_offset
		le.PutUint64(h[0x20:], size)                  // sh_size
		stripped = append(stripped, data[s.Offset:s.Offset+size]...)
	}
	for len(stripped)%8 != 0 {
		stripped = append(stripped, 0)
	}
	le.PutUint64(stripped[0x28:], uint64(len(stripped))) // e_shoff
	stripped = append(stripped, headers...)
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return "", err
	}
	return out, os.WriteFile(out, stripped, 0o755)
}
