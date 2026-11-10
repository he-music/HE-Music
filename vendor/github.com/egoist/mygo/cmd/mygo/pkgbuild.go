package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// pkgbuildName is the file of the Arch Linux package description that
// Linux builds get next to the app's archive.
const pkgbuildName = "PKGBUILD"

// archArch maps GOARCH to the architectures of Arch Linux, and of Arch
// Linux 32 and Arch Linux ARM for those it has not.
var archArch = map[string]string{"amd64": "x86_64", "arm64": "aarch64", "386": "i686", "arm": "armv7h", "riscv64": "riscv64"}

// archPackages maps the Debian packages that apps commonly depend on to
// those of Arch Linux, by the Debian name without its "t64" suffix.
var archPackages = map[string]string{
	"libgtk-3-0":                 "gtk3",
	"libwebkit2gtk-4.1-0":        "webkit2gtk-4.1",
	"libayatana-appindicator3-1": "libayatana-appindicator",
	"libnotify4":                 "libnotify",
	"libsecret-1-0":              "libsecret",
	"libsoup-3.0-0":              "libsoup3",
	"libglib2.0-0":               "glib2",
	"libasound2":                 "alsa-lib",
	"libpulse0":                  "libpulse",
	"libnss3":                    "nss",
	"libssl3":                    "openssl",
	"libx11-6":                   "libx11",
	"libxtst6":                   "libxtst",
	"libvulkan1":                 "vulkan-icd-loader",
	"libgl1":                     "libglvnd",
	"libegl1":                    "libglvnd",
	"gstreamer1.0-plugins-base":  "gst-plugins-base",
	"gstreamer1.0-plugins-good":  "gst-plugins-good",
	"gstreamer1.0-plugins-bad":   "gst-plugins-bad",
	"gstreamer1.0-plugins-ugly":  "gst-plugins-ugly",
	"gstreamer1.0-libav":         "gst-libav",
	"ffmpeg":                     "ffmpeg",
	"xdg-utils":                  "xdg-utils",
	"zenity":                     "zenity",
	"curl":                       "curl",
	"git":                        "git",
}

// archDepends returns the Arch Linux packages the app depends on, those of
// debDepends, and the Debian packages that have none archPackages knows.
// A Debian dependency is one package, with its version and architecture
// left out, or alternatives, of which the first that has one counts.
func (l *Linux) archDepends() (depends, unknown []string) {
	for _, dep := range l.debDepends() {
		found := ""
		for alt := range strings.SplitSeq(dep, "|") {
			deb, _, _ := strings.Cut(strings.TrimSpace(alt), " ")
			deb, _, _ = strings.Cut(deb, "(")
			deb, _, _ = strings.Cut(deb, ":")
			if found = archPackages[strings.TrimSuffix(deb, "t64")]; found != "" {
				break
			}
		}
		switch {
		case found == "":
			unknown = append(unknown, dep)
		case !slices.Contains(depends, found):
			depends = append(depends, found)
		}
	}
	return depends, unknown
}

// pkgnameRe matches what an Arch Linux package name cannot hold.
var pkgnameRe = regexp.MustCompile(`[^a-z0-9@._+-]+`)

// archPkgname makes the slug an Arch Linux package name: lower-case
// letters, digits and @._+-, not starting with a hyphen or a dot. A slug
// is one already.
func archPkgname(slug string) string {
	name := strings.TrimLeft(pkgnameRe.ReplaceAllString(strings.ToLower(slug), "-"), "-.")
	if name == "" {
		return "app"
	}
	return name
}

// pkgverRe matches what an Arch Linux package version cannot hold: it has
// letters, digits, periods and underscores.
var pkgverRe = regexp.MustCompile(`[^A-Za-z0-9._]+`)

// archVersion turns a semantic version into an Arch Linux pkgver, which
// cannot hold hyphens. vercmp sorts a version whose rest after the release
// starts with a letter before the release, as 1.2.0rc.1 < 1.2.0, but one
// whose rest starts with a separator after it, as 1.2.0_rc.1 > 1.2.0, so
// a pre-release follows the release without its hyphen (1.2.0beta.1 of
// 1.2.0-beta.1), and with "pre" when it starts with a digit (1.2.0pre1 of
// 1.2.0-1), which would otherwise run into the release's last number.
// Build metadata, which semantic versioning leaves out of the order,
// follows with an underscore (1.2.0_build.5 of 1.2.0+build.5), which
// sorts after the version without it, as a rebuild. Any other character
// a pkgver cannot hold becomes an underscore.
func archVersion(v string) string {
	v, build, _ := strings.Cut(strings.TrimPrefix(v, "v"), "+")
	v, pre, _ := strings.Cut(v, "-")
	if pre != "" && pre[0] >= '0' && pre[0] <= '9' {
		pre = "pre" + pre
	}
	v += pre
	if build != "" {
		v += "_" + build
	}
	if v = pkgverRe.ReplaceAllString(v, "_"); v == "" {
		return "0"
	}
	return v
}

// packageJSONString returns the string field key of the package.json of
// root, or "" without one.
func packageJSONString(root, key string) string {
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return ""
	}
	var pkg map[string]json.RawMessage
	var value string
	if json.Unmarshal(data, &pkg) != nil || json.Unmarshal(pkg[key], &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// archLicense returns the license of the app for its PKGBUILD: the SPDX
// expression of mygo.json, else of package.json, which Arch Linux takes
// too, else LicenseRef-custom, which says that the license is the app's
// own, as for UNLICENSED, npm's mark of a package that may not be used
// freely.
func archLicense(c *Config) string {
	license := c.License
	if license == "" {
		license = packageJSONString(c.root, "license")
	}
	license = strings.TrimSuffix(strings.TrimPrefix(license, "("), ")")
	if license == "" || license == "UNLICENSED" || strings.HasPrefix(license, "SEE LICENSE IN") {
		return "LicenseRef-custom"
	}
	return license
}

// archURL returns the home page of the app for its PKGBUILD: the homepage
// of package.json, else the repository of updates.github, else "".
func archURL(c *Config) string {
	if u := packageJSONString(c.root, "homepage"); u != "" {
		return u
	}
	if c.Updates != nil && c.Updates.GitHub != "" {
		return "https://github.com/" + c.Updates.GitHub
	}
	return ""
}

// shWordRe matches words that a shell reads as they are.
var shWordRe = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./_-]+$`)

// shWord quotes s for a POSIX shell, unless the shell reads it as it is.
func shWord(s string) string {
	if shWordRe.MatchString(s) {
		return s
	}
	return shQuote(s)
}

// shArray renders a bash array of words, each quoted.
func shArray(words []string) string {
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = shQuote(w)
	}
	return "(" + strings.Join(quoted, " ") + ")"
}

// writePKGBUILD writes into stage a PKGBUILD from which makepkg packages
// the app for Arch Linux, out of archive, its archive in stage, with the
// files of the Debian package of writeDeb, which app, the executable name
// and the files next to it, are too: the app in /opt/<name>, a link in
// /usr/bin for each name of linux.command, its desktop entry, its icons
// and its MIME package. The icons in the sizes of the Debian package are
// written next to it, as sources: the archive holds the original. It
// returns the files written.
//
// The Debian package registers its desktop entry, icons and MIME types
// through the triggers of the packages that own those directories, and
// the hooks of pacman do it for the same packages on Arch Linux, so the
// PKGBUILD needs no install script either.
func writePKGBUILD(c *Config, stage, name, goarch string, app []string, archive string) ([]string, error) {
	arch, ok := archArch[goarch]
	if !ok {
		return nil, fmt.Errorf("no Arch Linux architecture for %s", goarch)
	}
	icons, err := linuxIcons(c)
	if err != nil {
		return nil, err
	}
	var written []string
	sources := []string{filepath.Base(archive)}
	for _, icon := range icons {
		source := fmt.Sprintf("%s-%dx%d.png", name, icon.size, icon.size)
		path := filepath.Join(stage, source)
		if err := os.WriteFile(path, icon.png, 0o644); err != nil {
			return nil, err
		}
		written = append(written, path)
		sources = append(sources, source)
	}
	sums := make([]string, len(sources))
	for i, s := range sources {
		if sums[i], err = fileSHA256(filepath.Join(stage, s)); err != nil {
			return nil, err
		}
	}
	depends, unknown := c.Linux.archDepends()
	for _, dep := range unknown {
		warnf("Leaving %s out of the PKGBUILD's dependencies: it is a Debian package with no Arch Linux package known for it", dep)
	}
	description := c.Linux.Comment
	if description == "" {
		description = c.Name
	}

	var b strings.Builder
	if m := strings.Join(strings.Fields(c.Linux.Maintainer), " "); m != "" {
		b.WriteString("# Maintainer: " + m + "\n")
	}
	b.WriteString("# Written by mygo build next to the app's archive: makepkg -si packages\n# the app for Arch Linux and installs it.\n")
	fmt.Fprintf(&b, "pkgname=%s\npkgver=%s\npkgrel=1\npkgdesc=%s\narch=%s\n", shQuote(archPkgname(name)), shQuote(archVersion(c.Version)), shQuote(description), shArray([]string{arch}))
	if u := archURL(c); u != "" {
		fmt.Fprintf(&b, "url=%s\n", shQuote(u))
	}
	fmt.Fprintf(&b, "license=%s\n", shArray([]string{archLicense(c)}))
	fmt.Fprintf(&b, "depends=%s\n", shArray(depends))
	// The executable as built, as the Debian package has it.
	b.WriteString("options=('!strip' '!debug')\n")
	fmt.Fprintf(&b, "source=%s\nsha256sums=%s\n", shArray(sources), shArray(sums))

	opt := `"$pkgdir"/` + shWord("opt/"+name)
	b.WriteString("\npackage() {\n\tcd \"$srcdir\"\n")
	fmt.Fprintf(&b, "\tinstall -d %s\n", opt)
	var entries []string
	for _, e := range optEntries(app, name) {
		entries = append(entries, shWord(e))
	}
	fmt.Fprintf(&b, "\tcp -dR -- %s %s/\n", strings.Join(entries, " "), opt)
	b.WriteString("\t# The modes of the Debian package: 755 for directories and programs, 644\n\t# for the other files.\n")
	fmt.Fprintf(&b, "\tfind %s -type d -exec chmod 755 {} +\n", opt)
	fmt.Fprintf(&b, "\tfind %s -type f -perm /111 -exec chmod 755 {} +\n", opt)
	fmt.Fprintf(&b, "\tfind %s -type f ! -perm /111 -exec chmod 644 {} +\n", opt)
	if len(c.Linux.Command) > 0 {
		b.WriteString("\tinstall -d \"$pkgdir\"/usr/bin\n")
	}
	for _, command := range c.Linux.Command {
		fmt.Fprintf(&b, "\tln -s %s \"$pkgdir\"/%s\n", shWord("../../opt/"+name+"/"+name), shWord("usr/bin/"+command))
	}
	if mimePackage(c) != "" {
		// Types the app defines, as the archive has them.
		fmt.Fprintf(&b, "\tinstall -Dm644 %s \"$pkgdir\"/%s\n", shWord(name+".xml"), shWord("usr/share/mime/packages/"+name+".xml"))
	}
	// The entry runs the app by its path, as the Debian package's does.
	desktop := linuxDesktopEntry(c, "/opt/"+name+"/"+name, name)
	fmt.Fprintf(&b, "\tprintf '%%s' %s |\n\t\tinstall -Dm644 /dev/stdin \"$pkgdir\"/%s\n", shQuote(desktop), shWord("usr/share/applications/"+name+".desktop"))
	for i, icon := range icons {
		fmt.Fprintf(&b, "\tinstall -Dm644 %s \"$pkgdir\"/%s\n", shWord(sources[i+1]), shWord(icon.dir()+"/"+name+".png"))
	}
	b.WriteString("}\n")

	path := filepath.Join(stage, pkgbuildName)
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return nil, err
	}
	return append(written, path), nil
}
