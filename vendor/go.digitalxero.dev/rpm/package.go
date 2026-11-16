package rpm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strconv"
	"time"
)

// NewPackage returns a builder for a binary RPM. The returned value satisfies
// both PackageBuilder (during configuration) and, after Build, Package. This is
// the house "Builder IS Implementation" pattern: one unexported struct backs the
// whole chain.
func NewPackage() PackageBuilder {
	return newPackage(false)
}

func newPackage(source bool) *rpmPackage {
	return &rpmPackage{
		os:                "linux",
		arch:              "noarch",
		compressor:        defaultCompressor(),
		fileDigestAlgo:    DigestSHA256,
		payloadDigestAlgo: DigestSHA256,
		files:             map[string]*fileEntry{},
		scriptlets:        map[scriptletKind]*scriptletData{},
		customTags:        map[int]IndexEntry{},
		customSigs:        map[int]IndexEntry{},
		sourcePackage:     source,
		provides:          &relationSet{},
		requires:          &relationSet{},
		conflicts:         &relationSet{},
		obsoletes:         &relationSet{},
		recommends:        &relationSet{},
		suggests:          &relationSet{},
		supplements:       &relationSet{},
		enhances:          &relationSet{},
		order:             &relationSet{},
	}
}

// PackageBuilder declaratively assembles a binary RPM. All configuration methods
// chain. Build validates and returns the runtime Package.
type PackageBuilder interface {
	WithName(string) PackageBuilder
	WithVersion(string) PackageBuilder
	WithRelease(string) PackageBuilder
	WithSummary(string) PackageBuilder
	WithDescription(string) PackageBuilder
	WithArch(string) PackageBuilder
	WithOS(string) PackageBuilder
	WithVendor(string) PackageBuilder
	WithURL(string) PackageBuilder
	WithPackager(string) PackageBuilder
	WithGroup(string) PackageBuilder
	WithLicense(string) PackageBuilder
	WithBuildHost(string) PackageBuilder
	WithDistribution(string) PackageBuilder
	WithVCS(string) PackageBuilder

	WithEpoch(uint32) PackageBuilder
	WithoutEpoch() PackageBuilder
	WithBuildTime(time.Time) PackageBuilder
	WithPrefixes(...string) PackageBuilder

	WithCompressor(Compressor) PackageBuilder
	WithFileDigestAlgo(DigestAlgo) PackageBuilder
	WithPayloadDigestAlgo(DigestAlgo) PackageBuilder

	// Build/install constraints and metadata.
	WithExcludeArch(...string) PackageBuilder
	WithExclusiveArch(...string) PackageBuilder
	WithExcludeOS(...string) PackageBuilder
	WithExclusiveOS(...string) PackageBuilder
	WithBuildArchs(...string) PackageBuilder
	WithOptFlags(string) PackageBuilder
	WithPlatform(string) PackageBuilder
	// WithReservedSignatureSpace reserves n zero bytes in the signature header so
	// the package can be re-signed in place later (rpm --addsign).
	WithReservedSignatureSpace(n int) PackageBuilder

	// Files.
	WithFile(name string, body []byte) FileBuilder
	WithFileFromPath(rpmPath, diskPath string) FileBuilder
	File(name string) FileBuilder
	AddTree(fsys fs.FS, prefix string) error
	AddTar(r io.Reader) error
	AllowListDirs(...string) PackageBuilder
	// WithTempDir sets the directory used to spool the (compressed) payload while
	// streaming, so large packages are never held in memory. Defaults to the OS
	// temp dir; point it at real disk if your temp dir is RAM-backed (tmpfs).
	WithTempDir(string) PackageBuilder

	// Dependency relation sets.
	Provides() RelationSetBuilder
	Requires() RelationSetBuilder
	Conflicts() RelationSetBuilder
	Obsoletes() RelationSetBuilder
	Recommends() RelationSetBuilder
	Suggests() RelationSetBuilder
	Supplements() RelationSetBuilder
	Enhances() RelationSetBuilder
	OrderWithRequires() RelationSetBuilder

	// Scriptlets.
	Pretrans() ScriptletBuilder
	Prein() ScriptletBuilder
	Postin() ScriptletBuilder
	Preun() ScriptletBuilder
	Postun() ScriptletBuilder
	Posttrans() ScriptletBuilder
	VerifyScript() ScriptletBuilder

	// Triggers and changelog.
	Trigger(TriggerKind) TriggerBuilder
	Changelog() ChangelogBuilder

	// Signing.
	WithSigner(Signer) PackageBuilder
	WithPGPSignFunc(func([]byte) ([]byte, error)) PackageBuilder

	// Custom tag escape hatches.
	AddCustomTag(tag int, e IndexEntry) PackageBuilder
	AddCustomSig(tag int, e IndexEntry) PackageBuilder

	Build() (Package, error)
}

// Package is the built, immutable RPM. It serializes deterministically, so it may
// be written more than once.
type Package interface {
	// FullVersion is "version-release", or "version" when release is empty.
	FullVersion() string
	// WriteTo satisfies io.WriterTo.
	WriteTo(w io.Writer) (int64, error)
	// Write is the context-cancelable form.
	Write(ctx context.Context, w io.Writer) error
}

type rpmPackage struct {
	name, version, release    string
	summary, description      string
	arch, os                  string
	vendor, url, packager     string
	group, license, buildHost string
	distribution, vcs         string

	epoch     uint32
	epochSet  bool
	buildTime time.Time
	prefixes  []string

	compressor        Compressor
	fileDigestAlgo    DigestAlgo
	payloadDigestAlgo DigestAlgo

	excludeArch   []string
	excludeOS     []string
	exclusiveArch []string
	exclusiveOS   []string
	buildArchs    []string
	optFlags      string
	platform      string

	reservedSigSpace int
	tempDir          string

	files map[string]*fileEntry // keyed by path; sorted at serialize time

	provides, requires, conflicts, obsoletes    *relationSet
	recommends, suggests, supplements, enhances *relationSet
	order                                       *relationSet

	scriptlets map[scriptletKind]*scriptletData
	triggers   []*triggerData
	changelog  []changelogEntry

	signer      Signer
	pgpSignFunc func([]byte) ([]byte, error)

	customTags map[int]IndexEntry
	customSigs map[int]IndexEntry

	// Source-package state (see source.go).
	sourcePackage bool
	specFile      *fileEntry
	sources       []string
	patches       []string
	noSources     []int32
	noPatches     []int32

	errs []error
}

// fail records a deferred error surfaced by Build.
func (p *rpmPackage) fail(err error) {
	if err != nil {
		p.errs = append(p.errs, err)
	}
}

// --- metadata setters ---

func (p *rpmPackage) WithName(s string) PackageBuilder         { p.name = s; return p }
func (p *rpmPackage) WithVersion(s string) PackageBuilder      { p.version = s; return p }
func (p *rpmPackage) WithRelease(s string) PackageBuilder      { p.release = s; return p }
func (p *rpmPackage) WithSummary(s string) PackageBuilder      { p.summary = s; return p }
func (p *rpmPackage) WithDescription(s string) PackageBuilder  { p.description = s; return p }
func (p *rpmPackage) WithArch(s string) PackageBuilder         { p.arch = s; return p }
func (p *rpmPackage) WithOS(s string) PackageBuilder           { p.os = s; return p }
func (p *rpmPackage) WithVendor(s string) PackageBuilder       { p.vendor = s; return p }
func (p *rpmPackage) WithURL(s string) PackageBuilder          { p.url = s; return p }
func (p *rpmPackage) WithPackager(s string) PackageBuilder     { p.packager = s; return p }
func (p *rpmPackage) WithGroup(s string) PackageBuilder        { p.group = s; return p }
func (p *rpmPackage) WithLicense(s string) PackageBuilder      { p.license = s; return p }
func (p *rpmPackage) WithBuildHost(s string) PackageBuilder    { p.buildHost = s; return p }
func (p *rpmPackage) WithDistribution(s string) PackageBuilder { p.distribution = s; return p }
func (p *rpmPackage) WithVCS(s string) PackageBuilder          { p.vcs = s; return p }

func (p *rpmPackage) WithEpoch(e uint32) PackageBuilder {
	p.epoch, p.epochSet = e, true
	return p
}

func (p *rpmPackage) WithoutEpoch() PackageBuilder {
	p.epochSet = false
	return p
}

func (p *rpmPackage) WithBuildTime(t time.Time) PackageBuilder {
	p.buildTime = t
	return p
}

func (p *rpmPackage) WithPrefixes(prefixes ...string) PackageBuilder {
	p.prefixes = append(p.prefixes, prefixes...)
	return p
}

func (p *rpmPackage) WithCompressor(c Compressor) PackageBuilder {
	if c != nil {
		p.compressor = c
	}
	return p
}

func (p *rpmPackage) WithFileDigestAlgo(d DigestAlgo) PackageBuilder {
	p.fileDigestAlgo = d
	return p
}

func (p *rpmPackage) WithPayloadDigestAlgo(d DigestAlgo) PackageBuilder {
	p.payloadDigestAlgo = d
	return p
}

func (p *rpmPackage) WithExcludeArch(a ...string) PackageBuilder {
	p.excludeArch = append(p.excludeArch, a...)
	return p
}

func (p *rpmPackage) WithExclusiveArch(a ...string) PackageBuilder {
	p.exclusiveArch = append(p.exclusiveArch, a...)
	return p
}

func (p *rpmPackage) WithExcludeOS(o ...string) PackageBuilder {
	p.excludeOS = append(p.excludeOS, o...)
	return p
}

func (p *rpmPackage) WithExclusiveOS(o ...string) PackageBuilder {
	p.exclusiveOS = append(p.exclusiveOS, o...)
	return p
}

func (p *rpmPackage) WithBuildArchs(a ...string) PackageBuilder {
	p.buildArchs = append(p.buildArchs, a...)
	return p
}

func (p *rpmPackage) WithOptFlags(s string) PackageBuilder {
	p.optFlags = s
	return p
}

func (p *rpmPackage) WithPlatform(s string) PackageBuilder {
	p.platform = s
	return p
}

func (p *rpmPackage) WithReservedSignatureSpace(n int) PackageBuilder {
	p.reservedSigSpace = n
	return p
}

func (p *rpmPackage) WithTempDir(dir string) PackageBuilder {
	p.tempDir = dir
	return p
}

// --- signing / custom tags ---

func (p *rpmPackage) WithSigner(s Signer) PackageBuilder {
	p.signer = s
	return p
}

func (p *rpmPackage) WithPGPSignFunc(f func([]byte) ([]byte, error)) PackageBuilder {
	p.pgpSignFunc = f
	return p
}

func (p *rpmPackage) AddCustomTag(tag int, e IndexEntry) PackageBuilder {
	p.customTags[tag] = e
	return p
}

func (p *rpmPackage) AddCustomSig(tag int, e IndexEntry) PackageBuilder {
	p.customSigs[tag] = e
	return p
}

// --- finalize ---

// FullVersion combines version and release.
func (p *rpmPackage) FullVersion() string {
	if p.release != "" {
		return p.version + "-" + p.release
	}
	return p.version
}

// Build validates the package and returns it as the runtime Package interface.
func (p *rpmPackage) Build() (Package, error) {
	if len(p.errs) > 0 {
		return nil, errors.Join(p.errs...)
	}
	if p.name == "" {
		return nil, ErrNoName
	}
	if p.version == "" {
		return nil, ErrNoVersion
	}
	if p.sourcePackage && p.specFile == nil {
		return nil, ErrNoSpecFile
	}
	for _, f := range p.files {
		if f.ftype&GhostFile != 0 && (len(f.body) > 0 || f.open != nil) {
			return nil, ErrGhostHasBody
		}
	}
	for i, tr := range p.triggers {
		if err := tr.validate(); err != nil {
			return nil, fmt.Errorf("rpm: trigger %d %w", i, err)
		}
	}
	// A package always provides itself, and a binary package for an
	// architecture with an ISA also provides name(isa), matching what rpmbuild
	// emits for %{name}%{?_isa}.
	evr := p.evr()
	p.provides.addIfMissing(&relation{name: p.name, version: evr, sense: SenseEqual})
	if isa, ok := ISA(p.arch); ok && !p.sourcePackage {
		p.provides.addIfMissing(&relation{name: p.name + "(" + isa + ")", version: evr, sense: SenseEqual})
	}
	return p, nil
}

// evr is the "[epoch:]version-release" string rpm uses in the package's own
// provides; the epoch is included only when one is set.
func (p *rpmPackage) evr() string {
	if p.epochSet {
		return strconv.FormatUint(uint64(p.epoch), 10) + ":" + p.FullVersion()
	}
	return p.FullVersion()
}

// WriteTo streams the package to w. Content is never held wholly in memory; the
// compressed payload is spooled to a temp file (see WithTempDir).
func (p *rpmPackage) WriteTo(w io.Writer) (int64, error) {
	return p.writeTo(context.Background(), w)
}

// Write streams the package, honoring context cancellation.
func (p *rpmPackage) Write(ctx context.Context, w io.Writer) error {
	_, err := p.writeTo(ctx, w)
	return err
}
