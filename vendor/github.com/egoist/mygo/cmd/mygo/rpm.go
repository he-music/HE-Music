package main

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"go.digitalxero.dev/rpm"
)

// rpmRelease is the package release number, 1 as in the PKGBUILD.
var rpmRelease = "1"

// rpmArch maps GOARCH to RPM architectures.
//
// See:
//   - https://github.com/rpm-software-management/rpm/blob/master/rpmrc.in
//   - https://github.com/goreleaser/nfpm/blob/main/rpm/rpm.go
var rpmArch = map[string]string{"amd64": "x86_64", "arm64": "aarch64", "386": "i386", "arm": "armv7hl", "riscv64": "riscv64"}

// rpmPackages maps common Debian package names from Linux.Depends to the
// RPM requirements that provide them across distributions. GStreamer plugin
// groups are left out because their package names and contents differ by
// distribution, so this covers fewer packages than archPackages.
// Shared-library SONAMEs receive the architecture suffix in rpmDepends.
var rpmPackages = map[string][]string{
	"libgtk-3-0":                 {"libgtk-3.so.0"},
	"libwebkit2gtk-4.1-0":        {"libwebkit2gtk-4.1.so.0"},
	"libayatana-appindicator3-1": {"libayatana-appindicator3.so.1"},
	"libnotify4":                 {"libnotify.so.4"},
	"libsecret-1-0":              {"libsecret-1.so.0"},
	"libsoup-3.0-0":              {"libsoup-3.0.so.0"},
	"libglib2.0-0": {
		"libglib-2.0.so.0",
		"libgio-2.0.so.0",
		"libgobject-2.0.so.0",
		"libgmodule-2.0.so.0",
		"libgthread-2.0.so.0",
	},
	"libasound2": {"libasound.so.2"},
	"libpulse0":  {"libpulse.so.0"},
	"libnss3":    {"libnss3.so"},
	"libssl3":    {"libssl.so.3"},
	"libx11-6":   {"libX11.so.6"},
	"libxtst6":   {"libXtst.so.6"},
	"libvulkan1": {"libvulkan.so.1"},
	"libgl1":     {"libGL.so.1"},
	"libegl1":    {"libEGL.so.1"},
	"ffmpeg":     {"/usr/bin/ffmpeg"},
	"xdg-utils":  {"xdg-utils"},
	"zenity":     {"zenity"},
	"curl":       {"curl"},
	"git":        {"git"},
}

// rpmDepends returns the RPM requirements of the app: GTK and WebKitGTK by
// their shared library SONAMEs, which carry the "()(64bit)" marker on 64-bit
// architectures, followed by l.Depends.RPM as written, or when
// l.Depends.legacy is true (linux.depends is a list of Debian packages), the
// entries of debDepends mapped through rpmPackages along with the Debian
// packages that have none rpmPackages knows.
func (l *Linux) rpmDepends(goarch string) (depends, unknown []string) {
	suffix := ""
	switch goarch {
	case "amd64", "arm64", "riscv64":
		suffix = "()(64bit)"
	}

	if !l.Depends.legacy {
		depends = []string{"libgtk-3.so.0" + suffix}
		if l.webView() {
			depends = append(depends, "libwebkit2gtk-4.1.so.0"+suffix)
		}
		return append(depends, l.Depends.RPM...), nil
	}

	for _, dep := range l.debDepends() {
		var found []string
		for alt := range strings.SplitSeq(dep, "|") {
			deb, _, _ := strings.Cut(strings.TrimSpace(alt), " ")
			deb, _, _ = strings.Cut(deb, "(")
			deb, _, _ = strings.Cut(deb, ":")
			if found = rpmPackages[strings.TrimSuffix(deb, "t64")]; len(found) > 0 {
				break
			}
		}
		switch {
		case len(found) == 0:
			unknown = append(unknown, dep)
		default:
			for _, rpm := range found {
				if strings.Contains(rpm, ".so") {
					rpm += suffix
				}
				if !slices.Contains(depends, rpm) {
					depends = append(depends, rpm)
				}
			}
		}
	}
	return depends, unknown
}

// writeRpm packages the Linux app in stage with go.digitalxero.dev/rpm.
func writeRpm(c *Config, stage, name, goarch string, app []string) (string, error) {
	arch, ok := rpmArch[goarch]
	if !ok {
		return "", fmt.Errorf("no rpm architecture for: %s", goarch)
	}
	builder := rpm.NewPackage()
	files := rpmFiles{builder}

	opt := "opt/" + name
	files.dir(opt)

	for _, entry := range optEntries(app, name) {
		err := filepath.WalkDir(filepath.Join(stage, entry), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(stage, p)
			target := opt + "/" + filepath.ToSlash(rel)
			info, err := d.Info()
			if err != nil {
				return err
			}
			switch {
			case d.IsDir():
				files.dir(target)
			case info.Mode()&fs.ModeSymlink != 0:
				link, err := os.Readlink(p)
				if err != nil {
					return err
				}
				files.link(target, link)
			default:
				mode := uint(0o644)
				if info.Mode()&0o111 != 0 {
					mode = 0o755
				}
				files.fileFromPath(target, p, mode)
			}
			return nil
		})
		if err != nil {
			return "", err
		}
	}

	for _, command := range c.Linux.Command {
		files.link("usr/bin/"+command, "../../"+opt+"/"+name)
	}
	if xml := mimePackage(c); xml != "" {
		// Types the app defines; the shared-mime-info trigger registers them.
		files.file("usr/share/mime/packages/"+name+".xml", []byte(xml), 0o644)
	}

	desktop := []byte(linuxDesktopEntry(c, "/"+opt+"/"+name, name))
	files.file("usr/share/applications/"+name+".desktop", desktop, 0o644)
	icons, err := linuxIcons(c)
	if err != nil {
		return "", err
	}
	for _, icon := range icons {
		dir := icon.dir()
		files.file(dir+"/"+name+".png", icon.png, 0o644)
	}
	description := c.Linux.Comment
	if description == "" {
		description = c.Name
	}

	builder.WithName(name).
		WithArch(arch).
		WithVersion(rpmVersion(c.Version)).
		WithPackager(c.Linux.Maintainer).
		WithSummary(description).
		WithDescription(description).
		WithRelease(rpmRelease).
		WithLicense(c.linuxLicense())

	depends, unknown := c.Linux.rpmDepends(goarch)
	for _, dep := range unknown {
		warnf("Leaving %s out of the RPM package's dependencies: it is a Debian package with no RPM package known for it", dep)
	}
	requires := builder.Requires()
	for _, depend := range depends {
		requires.AddParsed(depend)
	}

	p, err := builder.Build()
	if err != nil {
		return "", err
	}

	outpath := filepath.Join(stage, fmt.Sprintf("%s-%s-%v.%s.rpm", name, rpmVersion(c.Version), rpmRelease, arch))
	out, err := os.Create(outpath)
	if err != nil {
		return "", err
	}
	_, err = p.WriteTo(out)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}

	return outpath, nil
}

// rpmVersionRe matches what an rpm version cannot hold: it has letters,
// digits, the separators . _ + and the operators ~ ^, and no dash, which
// separates the components of a package's file name.
var rpmVersionRe = regexp.MustCompile(`[^A-Za-z0-9._+~^]+`)

// rpmVersion turns a semantic version into an rpm one: a pre-release sorts
// before its release with "~", as rpm's tilde makes it older, its dashes,
// which an rpm version cannot hold, become underscores as any other
// character, and build metadata follows with "+", a separator like any
// other, which sorts the version after the one without it, as a rebuild.
// rpm compares a numeric segment as newer than an alphabetic one, unlike
// semantic versioning, so a pre-release of numbers alone, as 1.2.0-1,
// sorts after one with letters, as 1.2.0-rc.1.
func rpmVersion(v string) string {
	v = strings.TrimPrefix(v, "v")
	v, build, _ := strings.Cut(v, "+")
	v, pre, _ := strings.Cut(v, "-")
	if pre != "" {
		v += "~" + pre
	}
	if build != "" {
		v += "+" + build
	}
	if v = rpmVersionRe.ReplaceAllString(v, "_"); v == "" {
		return "0"
	}
	return v
}

type rpmFiles struct {
	builder rpm.PackageBuilder
}

func (r *rpmFiles) dir(name string) {
	r.builder.File(r.toAbsolute(name)).Directory().WithMode(0o755)
}

func (r *rpmFiles) file(name string, data []byte, mode uint) {
	r.builder.WithFile(r.toAbsolute(name), data).WithMode(mode)
}

// fileFromPath streams a file from disk without reading it into memory.
func (r *rpmFiles) fileFromPath(name, path string, mode uint) {
	r.builder.WithFileFromPath(r.toAbsolute(name), path).WithMode(mode)
}

func (r *rpmFiles) link(name, linkTo string) {
	r.builder.File(r.toAbsolute(name)).WithSymlink(linkTo).WithMode(0o777)
}

// toAbsolute turns a path relative to the root into the absolute path the RPM builder takes.
func (r *rpmFiles) toAbsolute(name string) string {
	return path.Join("/", name)
}
