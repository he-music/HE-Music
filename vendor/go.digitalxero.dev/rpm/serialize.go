package rpm

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path"
	"sort"
)

// serialize.go assembles the final RPM: it sorts files, builds the cpio payload,
// constructs the main header and signature indexes, and writes
// lead + signature + padding + header + payload.

// fileArrays holds the parallel per-file header arrays. Every slice must have the
// same length (the file count) or rpm rejects the package.
type fileArrays struct {
	dirnames    []string
	dirindexes  []int32
	basenames   []string
	sizes       []uint64
	modes       []uint16
	rdevs       []int16
	mtimes      []int32
	digests     []string
	linktos     []string
	flags       []int32
	usernames   []string
	groupnames  []string
	verifyflags []int32
	devices     []int32
	inodes      []int32
	langs       []string
	caps        []string
	colors      []int32
	classes     []string
	provides    [][]fileDep
	requires    [][]fileDep

	installedSize uint64
	anyCaps       bool
	anyColors     bool
	count         int
}

// renderFile is a single payload record to emit into the cpio archive. Content
// is either streamed (open != nil) or in-memory (body), never loaded whole for
// streamed sources.
type renderFile struct {
	index      int // position in the file arrays (for back-filling the digest)
	cpioName   string
	mode       uint32
	mtime      uint32
	ino        int
	nlink      int
	size       int64 // cpio content size (0 for dirs)
	open       func() (io.ReadCloser, error)
	body       []byte
	isRegular  bool
	hasPayload bool
}

func cpioName(p string) string {
	if len(p) > 0 && p[0] == '/' {
		return "." + p
	}
	return "./" + p
}

// processFiles walks the files in sorted path order and produces the header
// arrays plus the cpio render list.
func (p *rpmPackage) processFiles() (*fileArrays, []renderFile) {
	names := make([]string, 0, len(p.files))
	for name := range p.files {
		if name == "/" { // rpm forbids the root directory in the file list
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)

	fa := &fileArrays{}
	di := newDirIndex()
	var renders []renderFile

	for i, name := range names {
		fe := p.files[name]
		dir, base := path.Split(name)

		perm := fe.mode & 0o7777
		var mode uint
		var size uint64    // installed size (header)
		var cpioSize int64 // payload content size
		linkto := ""
		nlink := 1
		hasPayload := fe.ftype&GhostFile == 0
		isRegular := false
		var body []byte
		var open func() (io.ReadCloser, error)

		switch {
		case fe.isDirectory():
			mode = perm | modeDir
			size = 4096
			nlink = 2
		case fe.symlink:
			mode = perm | modeSymlink
			body = []byte(fe.symlinkTarget)
			cpioSize = int64(len(body))
			size = uint64(cpioSize)
			linkto = fe.symlinkTarget
		default:
			mode = perm | modeRegular
			isRegular = true
			cpioSize = fe.contentSize()
			size = uint64(cpioSize)
			body = fe.body
			open = fe.open
		}
		// Digests are computed while streaming the payload; see streamPayload.
		digest := ""

		owner := fe.owner
		if owner == "" {
			owner = "root"
		}
		group := fe.group
		if group == "" {
			group = "root"
		}
		verify := int32(AllVerifyFlags)
		if fe.verifySet {
			verify = int32(fe.verifyFlags)
		}

		fa.dirindexes = append(fa.dirindexes, di.get(dir))
		fa.basenames = append(fa.basenames, base)
		fa.sizes = append(fa.sizes, size)
		fa.modes = append(fa.modes, uint16(mode))
		fa.rdevs = append(fa.rdevs, 1)
		fa.mtimes = append(fa.mtimes, int32(fe.mtime))
		fa.digests = append(fa.digests, digest)
		fa.linktos = append(fa.linktos, linkto)
		// Derive the spec flag from the authoritative specFile reference so a
		// later WithType cannot accidentally clear it.
		flags := int32(fe.ftype)
		if fe == p.specFile {
			flags |= fileFlagSpecFile
		}
		fa.flags = append(fa.flags, flags)
		fa.usernames = append(fa.usernames, owner)
		fa.groupnames = append(fa.groupnames, group)
		fa.verifyflags = append(fa.verifyflags, verify)
		fa.devices = append(fa.devices, 1)
		fa.inodes = append(fa.inodes, int32(i+1))
		fa.langs = append(fa.langs, fe.lang)
		fa.caps = append(fa.caps, fe.caps)
		fa.colors = append(fa.colors, int32(fe.color))
		fa.classes = append(fa.classes, fe.class)
		fa.provides = append(fa.provides, fe.provides)
		fa.requires = append(fa.requires, fe.requires)
		fa.installedSize += size
		if fe.caps != "" {
			fa.anyCaps = true
		}
		if fe.color != FileColorNone {
			fa.anyColors = true
		}

		renders = append(renders, renderFile{
			index:      i,
			cpioName:   cpioName(name),
			mode:       uint32(mode),
			mtime:      fe.mtime,
			ino:        i + 1,
			nlink:      nlink,
			size:       cpioSize,
			open:       open,
			body:       body,
			isRegular:  isRegular,
			hasPayload: hasPayload,
		})
	}

	fa.dirnames = di.all()
	fa.count = len(names)
	return fa, renders
}

// streamPayload writes the compressed cpio archive to spool, streaming each
// file's content (never loading it whole), and fills fa.digests for regular
// files as it goes. It returns the uncompressed archive size and the hex digest
// of the compressed payload.
func (p *rpmPackage) streamPayload(ctx context.Context, spool io.Writer, fa *fileArrays, renders []renderFile) (archiveSize uint64, payloadDigest string, err error) {
	payloadHash := p.payloadDigestAlgo.newHash()
	zw, err := p.compressor.newWriter(io.MultiWriter(spool, payloadHash))
	if err != nil {
		return 0, "", fmt.Errorf("rpm: creating %s writer: %w", p.compressor.name(), err)
	}
	cw := newCPIOWriter(zw)

	for _, rf := range renders {
		if err := ctx.Err(); err != nil {
			return 0, "", err
		}
		if !rf.hasPayload {
			continue
		}

		var content io.Reader
		var closer io.Closer
		switch {
		case rf.open != nil:
			rc, oerr := rf.open()
			if oerr != nil {
				return 0, "", fmt.Errorf("rpm: opening %q: %w", rf.cpioName, oerr)
			}
			content, closer = rc, rc
		default:
			content = bytes.NewReader(rf.body)
		}

		var fh hash.Hash
		if rf.isRegular {
			fh = p.fileDigestAlgo.newHash()
			content = io.TeeReader(content, fh)
		}

		werr := cw.writeEntry(rf.cpioName, rf.mode, rf.mtime, rf.ino, rf.nlink, rf.size, content)
		if closer != nil {
			closer.Close()
		}
		if werr != nil {
			return 0, "", werr
		}
		if rf.isRegular {
			fa.digests[rf.index] = hex.EncodeToString(fh.Sum(nil))
		}
	}

	if err := cw.close(); err != nil {
		return 0, "", err
	}
	if err := zw.Close(); err != nil {
		return 0, "", fmt.Errorf("rpm: closing %s writer: %w", p.compressor.name(), err)
	}
	return uint64(cw.written), hex.EncodeToString(payloadHash.Sum(nil)), nil
}

// writeTo streams the full RPM to w without holding the package in memory: the
// (compressed) payload is spooled to a temp file on disk, the small headers are
// built once the payload digests/sizes are known, and then lead + signature +
// header + spooled payload are streamed to w.
func (p *rpmPackage) writeTo(ctx context.Context, w io.Writer) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	fa, renders := p.processFiles()

	spool, err := os.CreateTemp(p.tempDir, "rpm-payload-*")
	if err != nil {
		return 0, fmt.Errorf("rpm: creating payload spool: %w", err)
	}
	defer func() {
		spool.Close()
		os.Remove(spool.Name())
	}()

	archiveSize, payloadDigest, err := p.streamPayload(ctx, spool, fa, renders)
	if err != nil {
		return 0, err
	}
	info, err := spool.Stat()
	if err != nil {
		return 0, fmt.Errorf("rpm: stat payload spool: %w", err)
	}
	compressedSize := info.Size()

	// Merge any file-level dependencies into local copies of the provide/require
	// lists so the per-file dependency dictionary can index into them without
	// mutating the builder (keeping serialize pure/repeatable).
	mergedProvides := append([]*relation(nil), p.provides.rels...)
	mergedRequires := append([]*relation(nil), p.requires.rels...)
	ddict, fdx, fdn, anyFileDep := buildFileDeps(fa, &mergedProvides, &mergedRequires)
	classDict, fileClass, anyClass := buildClassDict(fa.classes)

	h := newIndex(regionImmutable)
	p.writeGenIndexes(h, fa, payloadDigest)
	if fa.count > 0 {
		p.writeFileIndexes(h, fa)
		if anyClass {
			h.add(tagClassDict, EntryStringSlice(classDict))
			h.add(tagFileClass, EntryInt32(fileClass))
		}
		if anyFileDep {
			h.add(tagDependsDict, EntryInt32(ddict))
			h.add(tagFileDependsX, EntryInt32(fdx))
			h.add(tagFileDependsN, EntryInt32(fdn))
		}
	}
	p.writeRelationIndexes(h, mergedProvides, mergedRequires, fa.count)
	p.writeScriptlets(h)
	p.writeTriggers(h)
	p.writeChangelog(h)
	if p.sourcePackage {
		p.writeSourceTags(h)
	}
	h.addEntries(p.customTags)
	headerBytes := h.bytes()

	s := newIndex(regionSignatures)
	if err := p.writeSignatures(s, headerBytes, spool, compressedSize, archiveSize); err != nil {
		return 0, err
	}
	s.addEntries(p.customSigs)
	sigBytes := s.bytes()

	// Stream lead + signature + padding + header to w, then copy the spooled
	// payload.
	cw := &countingWriter{w: w}
	cw.Write(writeLead(p.name, p.FullVersion(), p.sourcePackage))
	cw.Write(sigBytes)
	cw.Write(make([]byte, (8-len(sigBytes)%8)%8))
	cw.Write(headerBytes)
	if cw.err != nil {
		return cw.n, cw.err
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return cw.n, fmt.Errorf("rpm: rewinding payload spool: %w", err)
	}
	if _, err := io.Copy(cw, spool); err != nil { // cw.Write counts the bytes
		return cw.n, fmt.Errorf("rpm: writing payload: %w", err)
	}
	return cw.n, cw.err
}

// countingWriter tracks bytes written and the first error.
type countingWriter struct {
	w   io.Writer
	n   int64
	err error
}

func (c *countingWriter) Write(b []byte) (int, error) {
	if c.err != nil {
		return 0, c.err
	}
	n, err := c.w.Write(b)
	c.n += int64(n)
	c.err = err
	return n, err
}

// buildClassDict builds the deduplicated CLASSDICT (index 0 is the empty class)
// and the per-file FILECLASS indexes.
func buildClassDict(classes []string) (dict []string, index []int32, any bool) {
	dict = []string{""}
	pos := map[string]int32{"": 0}
	index = make([]int32, len(classes))
	for i, c := range classes {
		if c == "" {
			continue
		}
		any = true
		j, ok := pos[c]
		if !ok {
			j = int32(len(dict))
			dict = append(dict, c)
			pos[c] = j
		}
		index[i] = j
	}
	return dict, index, any
}

// buildFileDeps builds the DEPENDSDICT plus per-file FILEDEPENDSX (offset) and
// FILEDEPENDSN (count). Each dictionary entry is (deptype<<24)|index, where
// deptype is 'P' for a provide or 'R' for a require and index points into the
// (merged) provide/require name array.
func buildFileDeps(fa *fileArrays, provides, requires *[]*relation) (ddict, fdx, fdn []int32, any bool) {
	fdx = make([]int32, fa.count)
	fdn = make([]int32, fa.count)
	for i := range fa.count {
		fdx[i] = int32(len(ddict))
		for _, d := range fa.provides[i] {
			ix := findOrAddRelation(provides, d)
			ddict = append(ddict, int32('P')<<24|(ix&0x00ffffff))
		}
		for _, d := range fa.requires[i] {
			ix := findOrAddRelation(requires, d)
			ddict = append(ddict, int32('R')<<24|(ix&0x00ffffff))
		}
		fdn[i] = int32(len(ddict)) - fdx[i]
		if fdn[i] > 0 {
			any = true
		}
	}
	return ddict, fdx, fdn, any
}

// findOrAddRelation returns the index of a matching relation in set, appending it
// if absent.
func findOrAddRelation(set *[]*relation, d fileDep) int32 {
	for i, r := range *set {
		if r.name == d.name && r.version == d.version && r.sense == d.sense {
			return int32(i)
		}
	}
	*set = append(*set, &relation{name: d.name, version: d.version, sense: d.sense})
	return int32(len(*set) - 1)
}
