package rpm

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
)

// FileType classifies a payload file. The values are the RPMFILE_* bit flags, so
// they may be OR'd together. GenericFile (0) is a plain file.
type FileType int32

const (
	// GenericFile is an ordinary file (the zero value).
	GenericFile FileType = 1 << iota >> 1
	// ConfigFile marks a configuration file (preserved across upgrades).
	ConfigFile
	// DocFile marks documentation.
	DocFile
	// reserved by rpm (RPMFILE_ICON); the blank keeps the bit positions aligned.
	_
	// MissingOkFile may be absent on the installed system.
	MissingOkFile
	// NoReplaceFile is not overwritten on upgrade if locally modified.
	NoReplaceFile
	// SpecFile is the package spec file (source packages).
	SpecFile
	// GhostFile is owned by the package but not shipped in the payload.
	GhostFile
	// LicenceFile marks a license file.
	LicenceFile
	// ReadmeFile marks a readme file.
	ReadmeFile
	// ExcludeFile is excluded from the package.
	ExcludeFile
)

// FileColor records the ELF class of a file for multilib coexistence.
type FileColor int32

const (
	// FileColorNone is the default (no ELF color).
	FileColorNone FileColor = 0
	// FileColorELF32 marks a 32-bit ELF object.
	FileColorELF32 FileColor = 1
	// FileColorELF64 marks a 64-bit ELF object.
	FileColorELF64 FileColor = 2
)

// VerifyFlags is the RPMVERIFY_* bitfield controlling which attributes rpm -V
// checks. The default, AllVerifyFlags, verifies everything.
type VerifyFlags int32

const (
	// AllVerifyFlags enables every verification check (rpm's default).
	AllVerifyFlags VerifyFlags = -1
	// VerifyNone disables verification.
	VerifyNone VerifyFlags = 0
)

// Unix file-type bits used when composing FILEMODES.
const (
	modeDir     = 0o040000
	modeRegular = 0o100000
	modeSymlink = 0o120000
)

// FileBuilder configures a single payload file. Obtain one from
// PackageBuilder.File or PackageBuilder.WithFile, then chain attributes and call
// Add to return to the package.
type FileBuilder interface {
	WithBody([]byte) FileBuilder
	// FromPath streams the file's content from a path on disk instead of holding
	// it in memory. The source is re-opened per write, so the package stays
	// re-writable; the size is read from the file when this is called.
	FromPath(diskPath string) FileBuilder
	// WithReader streams content from r exactly once; size must be the exact byte
	// count. A package using a reader source can only be written once.
	WithReader(r io.Reader, size int64) FileBuilder
	// WithOpener streams content from a re-openable source of the given size.
	WithOpener(open func() (io.ReadCloser, error), size int64) FileBuilder
	WithMode(uint) FileBuilder
	WithOwner(string) FileBuilder
	WithGroup(string) FileBuilder
	WithMTime(uint32) FileBuilder
	WithType(FileType) FileBuilder
	WithSymlink(target string) FileBuilder
	WithCapabilities(string) FileBuilder
	WithLang(string) FileBuilder
	WithColor(FileColor) FileBuilder
	WithVerifyFlags(VerifyFlags) FileBuilder
	// WithClass sets the file's classification string (as produced by file(1)/
	// libmagic), recorded via the deduplicated CLASSDICT/FILECLASS tags.
	WithClass(string) FileBuilder
	// WithProvides adds a file-level provide (e.g. an soname this file supplies).
	WithProvides(name, version string, sense Sense) FileBuilder
	// WithRequires adds a file-level require (e.g. an soname this file needs).
	WithRequires(name, version string, sense Sense) FileBuilder
	// Directory marks this entry as a packaged directory.
	Directory() FileBuilder
	// Add returns to the parent package builder.
	Add() PackageBuilder
}

type fileEntry struct {
	path string
	// Content is either an in-memory body or a streamed source (open != nil),
	// never both. size is the content length for a streamed source.
	body  []byte
	open  func() (io.ReadCloser, error)
	size  int64
	mode  uint
	owner string
	group string
	mtime uint32
	ftype FileType

	caps  string
	lang  string
	color FileColor

	verifyFlags VerifyFlags
	verifySet   bool

	class    string
	provides []fileDep
	requires []fileDep

	symlink       bool
	symlinkTarget string
	dir           bool
}

// fileDep is a file-level provide or require.
type fileDep struct {
	name    string
	version string
	sense   Sense
}

// contentSize returns the file's content length without reading it.
func (fe *fileEntry) contentSize() int64 {
	if fe.open != nil {
		return fe.size
	}
	return int64(len(fe.body))
}

type fileHandle struct {
	pkg *rpmPackage
	fe  *fileEntry
}

func (h *fileHandle) WithBody(b []byte) FileBuilder {
	h.fe.body, h.fe.open, h.fe.size = b, nil, 0
	return h
}

func (h *fileHandle) FromPath(diskPath string) FileBuilder {
	h.pkg.setFromPath(h.fe, diskPath)
	return h
}

// setFromPath points fe's content at a disk path, streaming on demand. Any stat
// error is deferred to Build.
func (p *rpmPackage) setFromPath(fe *fileEntry, diskPath string) {
	info, err := os.Stat(diskPath)
	if err != nil {
		p.fail(fmt.Errorf("rpm: stat %q: %w", diskPath, err))
		return
	}
	fe.body = nil
	fe.size = info.Size()
	fe.open = func() (io.ReadCloser, error) { return os.Open(diskPath) }
}

func (h *fileHandle) WithReader(r io.Reader, size int64) FileBuilder {
	used := false
	h.fe.body = nil
	h.fe.size = size
	h.fe.open = func() (io.ReadCloser, error) {
		if used {
			return nil, errors.New("rpm: reader source already consumed; use FromPath or WithOpener for a re-writable package")
		}
		used = true
		return io.NopCloser(r), nil
	}
	return h
}

func (h *fileHandle) WithOpener(open func() (io.ReadCloser, error), size int64) FileBuilder {
	h.fe.body = nil
	h.fe.size = size
	h.fe.open = open
	return h
}

func (h *fileHandle) WithMode(m uint) FileBuilder           { h.fe.mode = m; return h }
func (h *fileHandle) WithOwner(o string) FileBuilder        { h.fe.owner = o; return h }
func (h *fileHandle) WithGroup(g string) FileBuilder        { h.fe.group = g; return h }
func (h *fileHandle) WithMTime(t uint32) FileBuilder        { h.fe.mtime = t; return h }
func (h *fileHandle) WithType(t FileType) FileBuilder       { h.fe.ftype = t; return h }
func (h *fileHandle) WithCapabilities(c string) FileBuilder { h.fe.caps = c; return h }
func (h *fileHandle) WithLang(l string) FileBuilder         { h.fe.lang = l; return h }
func (h *fileHandle) WithColor(c FileColor) FileBuilder     { h.fe.color = c; return h }

func (h *fileHandle) WithSymlink(target string) FileBuilder {
	h.fe.symlink = true
	h.fe.symlinkTarget = target
	h.fe.body, h.fe.open, h.fe.size = []byte(target), nil, 0
	return h
}

func (h *fileHandle) WithVerifyFlags(v VerifyFlags) FileBuilder {
	h.fe.verifyFlags, h.fe.verifySet = v, true
	return h
}

func (h *fileHandle) WithClass(c string) FileBuilder {
	h.fe.class = c
	return h
}

func (h *fileHandle) WithProvides(name, version string, sense Sense) FileBuilder {
	h.fe.provides = append(h.fe.provides, fileDep{name: name, version: version, sense: sense})
	return h
}

func (h *fileHandle) WithRequires(name, version string, sense Sense) FileBuilder {
	h.fe.requires = append(h.fe.requires, fileDep{name: name, version: version, sense: sense})
	return h
}

func (h *fileHandle) Directory() FileBuilder {
	h.fe.dir = true
	return h
}

func (h *fileHandle) Add() PackageBuilder { return h.pkg }

// fileFor returns the entry for name, creating it on first use. The root "/" is
// not a valid file and yields a throwaway entry that serialize ignores.
func (p *rpmPackage) fileFor(name string) *fileEntry {
	if fe, ok := p.files[name]; ok {
		return fe
	}
	fe := &fileEntry{path: name, mode: 0o644}
	p.files[name] = fe
	return fe
}

// File registers (or returns) a file by name for configuration.
func (p *rpmPackage) File(name string) FileBuilder {
	return &fileHandle{pkg: p, fe: p.fileFor(name)}
}

// WithFile registers a file with its body in one call.
func (p *rpmPackage) WithFile(name string, body []byte) FileBuilder {
	fe := p.fileFor(name)
	fe.body, fe.open, fe.size = body, nil, 0
	return &fileHandle{pkg: p, fe: fe}
}

// WithFileFromPath registers a file whose content is streamed from a path on
// disk, so large files are never loaded into memory.
func (p *rpmPackage) WithFileFromPath(rpmPath, diskPath string) FileBuilder {
	return p.File(rpmPath).FromPath(diskPath)
}

// AllowListDirs removes packaged directory entries whose path is not listed. It
// mirrors rpmpack's directory allow-listing; non-directory files are untouched.
func (p *rpmPackage) AllowListDirs(dirs ...string) PackageBuilder {
	allow := make(map[string]bool, len(dirs))
	for _, d := range dirs {
		allow[d] = true
	}
	for name, fe := range p.files {
		if fe.isDirectory() && !allow[name] {
			delete(p.files, name)
		}
	}
	return p
}

func (fe *fileEntry) isDirectory() bool {
	return fe.dir || fe.mode&modeDir == modeDir
}

// AddTree harvests every regular file and symlink from fsys into the package
// under prefix, sorted by path for determinism.
func (p *rpmPackage) AddTree(fsys fs.FS, prefix string) error {
	var paths []string
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		paths = append(paths, name)
		return nil
	})
	if err != nil {
		return fmt.Errorf("rpm: walking tree: %w", err)
	}
	sort.Strings(paths)
	for _, name := range paths {
		// Lstat so symlinks report as links rather than their targets; it falls
		// back to Stat on filesystems that do not implement fs.ReadLinkFS.
		info, err := fs.Lstat(fsys, name)
		if err != nil {
			return fmt.Errorf("rpm: stat %q: %w", name, err)
		}
		target := path.Join("/", prefix, name)
		fb := p.File(target).
			WithMode(uint(info.Mode().Perm())).
			WithMTime(uint32(info.ModTime().Unix())).
			WithOwner("root").WithGroup("root")
		if info.Mode()&fs.ModeSymlink != 0 {
			link, lerr := readLink(fsys, name)
			if lerr != nil {
				return fmt.Errorf("rpm: readlink %q: %w", name, lerr)
			}
			fb.WithSymlink(link)
			continue
		}
		// Stream the file from the FS rather than reading it all into memory.
		fb.WithOpener(func() (io.ReadCloser, error) { return fsys.Open(name) }, info.Size())
	}
	return nil
}

// readLink reads a symlink target from fsys if it supports fs.ReadLinkFS.
func readLink(fsys fs.FS, name string) (string, error) {
	if rl, ok := fsys.(fs.ReadLinkFS); ok {
		return rl.ReadLink(name)
	}
	return "", fmt.Errorf("filesystem does not support symlinks")
}

// AddTar harvests files, directories, and symlinks from a tar stream.
func (p *rpmPackage) AddTar(r io.Reader) error {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("rpm: reading tar: %w", err)
		}
		name := path.Join("/", hdr.Name)
		owner := hdr.Uname
		if owner == "" {
			owner = "root"
		}
		group := hdr.Gname
		if group == "" {
			group = "root"
		}
		fb := p.File(name).
			WithMode(uint(hdr.Mode)).
			WithMTime(uint32(hdr.ModTime.Unix())).
			WithOwner(owner).WithGroup(group)
		switch hdr.Typeflag {
		case tar.TypeDir:
			fb.Directory()
		case tar.TypeSymlink:
			fb.WithSymlink(hdr.Linkname)
		case tar.TypeLink:
			// RPM has no payload hardlink concept, so materialize the hardlink as
			// an independent copy of its (already-seen) target's content.
			target := path.Join("/", hdr.Linkname)
			src, ok := p.files[target]
			if !ok {
				return fmt.Errorf("rpm: tar hardlink %q -> %q: target not found", name, hdr.Linkname)
			}
			fb.WithBody(append([]byte(nil), src.body...))
		default:
			data, rerr := io.ReadAll(tr)
			if rerr != nil {
				return fmt.Errorf("rpm: reading tar entry %q: %w", name, rerr)
			}
			fb.WithBody(data)
		}
	}
	return nil
}
