package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/egoist/mygo/internal/nativegen"
	"github.com/egoist/mygo/internal/nativelib"
)

// The Swift libraries of the app: native modules' implementations, and
// Swift packages that packages bind by hand with ffi. They build on macOS,
// universal, are published as an archive of the library and the
// frameworks its package brings (nativelib.IsArchive), under
// nativelib.Universal, and go into the app's Contents/Frameworks.

// moduleSourceHash hashes what the implementation of module m builds from:
// its Swift package's sources (nativelib.SourceHash) and those of the
// native modules it uses, whose Swift it imports and links, so that a
// published build goes stale with theirs too. A module that uses none has
// its package's hash.
func moduleSourceHash(m *nativegen.Module) (string, error) {
	own, err := nativelib.SourceHash(filepath.Join(m.Dir, "swift"), &nativelib.Build{Swift: "./swift"})
	if err != nil || len(m.Deps) == 0 {
		return own, err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00", own)
	for _, path := range slices.Sorted(maps.Keys(m.Deps)) {
		dep, err := moduleSourceHash(m.Deps[path])
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s\x00%s\x00", path, dep)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// usePublishedSwift downloads and unpacks the published build f of the
// Swift library name into the user's cache, and returns it as a build.
func usePublishedSwift(dir, name string, f nativelib.File) (nativeBuild, error) {
	t := con.start("Downloading the published build of " + name)
	archive, err := fetchNative(f)
	if err != nil {
		return nativeBuild{}, t.end(err, "")
	}
	b := nativeBuild{name: name, dir: dir}
	if !nativelib.IsArchive(f.Name) {
		b.dylib = archive
		return b, t.end(nil, "Downloaded the published build of "+name)
	}
	out := filepath.Join(filepath.Dir(archive), "unpacked")
	b.dylib = filepath.Join(out, "lib"+name+".dylib")
	if _, err := os.Stat(b.dylib); err != nil {
		if err := untar(archive, out); err != nil {
			return nativeBuild{}, t.end(fmt.Errorf("%s: %w", f.Name, err), "")
		}
	}
	entries, err := os.ReadDir(out)
	if err != nil {
		return nativeBuild{}, t.end(err, "")
	}
	for _, e := range entries {
		if p := filepath.Join(out, e.Name()); p != b.dylib {
			b.frameworks = append(b.frameworks, p)
		}
	}
	if _, err := os.Stat(b.dylib); err != nil {
		return nativeBuild{}, t.end(fmt.Errorf("%s holds no lib%s.dylib", f.Name, name), "")
	}
	return b, t.end(nil, "Downloaded the published build of "+name)
}

// untar unpacks a .tar.gz into dir, which it replaces.
func untar(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tmp := dir + ".tmp"
	os.RemoveAll(tmp)
	r := tar.NewReader(z)
	for {
		h, err := r.Next()
		if errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return err
		}
		name := filepath.Clean(filepath.FromSlash(h.Name))
		if !filepath.IsLocal(name) {
			return fmt.Errorf("the archive holds %s, outside it", h.Name)
		}
		path := filepath.Join(tmp, name)
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o755)
		case tar.TypeSymlink:
			// The target, from the link's own directory, stays in the
			// archive: an absolute one never does.
			target := filepath.FromSlash(h.Linkname)
			if filepath.IsAbs(target) || h.Linkname == "" || !filepath.IsLocal(filepath.Join(filepath.Dir(name), target)) {
				return fmt.Errorf("the archive links %s to %s, out of it", h.Name, h.Linkname)
			}
			if err = os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
				err = os.Symlink(h.Linkname, path)
			}
		case tar.TypeReg:
			if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				break
			}
			// Nor through a link it made before.
			var real string
			if real, err = filepath.EvalSymlinks(filepath.Dir(path)); err != nil {
				break
			}
			if root, rerr := filepath.EvalSymlinks(tmp); rerr != nil || (real != root && !strings.HasPrefix(real, root+string(filepath.Separator))) {
				err = fmt.Errorf("the archive writes %s out of it", h.Name)
				break
			}
			var w *os.File
			if w, err = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(h.Mode)&0o755|0o644); err != nil {
				break
			}
			_, err = io.Copy(w, r)
			if cerr := w.Close(); err == nil {
				err = cerr
			}
		}
		if err != nil {
			return err
		}
	}
	os.RemoveAll(dir)
	return os.Rename(tmp, dir)
}

// tarDir packs the files and directories paths, by their base names, into
// a .tar.gz at out.
func tarDir(out string, paths []string) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	z := gzip.NewWriter(f)
	w := tar.NewWriter(z)
	for _, root := range paths {
		base := filepath.Dir(root)
		err := filepath.Walk(root, func(path string, info fs.FileInfo, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(base, path)
			link := ""
			if info.Mode()&fs.ModeSymlink != 0 {
				if link, err = os.Readlink(path); err != nil {
					return err
				}
			}
			h, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return err
			}
			h.Name = filepath.ToSlash(rel)
			h.ModTime, h.Uid, h.Gid, h.Uname, h.Gname = h.ModTime.Truncate(0).UTC(), 0, 0, "", ""
			if err := w.WriteHeader(h); err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				src, err := os.Open(path)
				if err != nil {
					return err
				}
				_, err = io.Copy(w, src)
				src.Close()
				return err
			}
			return nil
		})
		if err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Close(); err != nil {
		f.Close()
		return err
	}
	if err := z.Close(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

var githubRemote = regexp.MustCompile(`github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$`)

// gitHubRepo returns the GitHub repository of the git checkout dir is in,
// as owner/name, from its remote origin.
func gitHubRepo(dir string) (string, error) {
	out, err := exec.Command("git", "-C", dir, "remote", "get-url", "origin").Output()
	if err != nil {
		return "", errors.New("it is in no git checkout with a remote origin on GitHub: name the release with -release")
	}
	m := githubRemote.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", fmt.Errorf("the remote origin %s is not on GitHub: name the release with -release", strings.TrimSpace(string(out)))
	}
	return m[1], nil
}
