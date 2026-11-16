package rpm

import (
	"io"
	"io/fs"
	"time"
)

// source.go adds source RPM (.src.rpm) authoring. A source package reuses the
// entire binary encoder; only the tag-population strategy differs: it sets
// SOURCEPACKAGE, omits SOURCERPM, uses arch "src", lays its files out flat, flags
// the spec file, and records the SOURCE/PATCH listings.
//
// SourcePackageBuilder wraps the shared *rpmPackage so that both the
// source-specific methods and the shared metadata setters return
// SourcePackageBuilder. That lets a chain mix them in any order. Sub-builders
// (files, relations, scriptlets, ...) return their usual builder, whose terminal
// returns the base PackageBuilder.

// NewSourcePackage returns a builder for a source RPM.
func NewSourcePackage() SourcePackageBuilder {
	p := newPackage(true)
	p.arch = "src"
	return &srcBuilder{p}
}

// SourcePackageBuilder assembles a source RPM.
type SourcePackageBuilder interface {
	// WithSpecFile sets the spec file (required). It is flagged RPMFILE_SPECFILE.
	WithSpecFile(name string, body []byte) SourcePackageBuilder
	// WithSource adds a source archive, recorded in the SOURCE listing.
	WithSource(name string, body []byte) SourcePackageBuilder
	// WithSourceFromPath adds a source archive streamed from a disk path (so large
	// tarballs are not held in memory).
	WithSourceFromPath(name, diskPath string) SourcePackageBuilder
	// WithPatch adds a patch, recorded in the PATCH listing.
	WithPatch(name string, body []byte) SourcePackageBuilder
	// WithPatchFromPath adds a patch streamed from a disk path.
	WithPatchFromPath(name, diskPath string) SourcePackageBuilder
	// WithExcludedSource records a source index present in the spec but not shipped.
	WithExcludedSource(index int) SourcePackageBuilder
	// WithExcludedPatch records a patch index present in the spec but not shipped.
	WithExcludedPatch(index int) SourcePackageBuilder

	WithName(string) SourcePackageBuilder
	WithVersion(string) SourcePackageBuilder
	WithRelease(string) SourcePackageBuilder
	WithSummary(string) SourcePackageBuilder
	WithDescription(string) SourcePackageBuilder
	WithArch(string) SourcePackageBuilder
	WithOS(string) SourcePackageBuilder
	WithVendor(string) SourcePackageBuilder
	WithURL(string) SourcePackageBuilder
	WithPackager(string) SourcePackageBuilder
	WithGroup(string) SourcePackageBuilder
	WithLicense(string) SourcePackageBuilder
	WithBuildHost(string) SourcePackageBuilder
	WithDistribution(string) SourcePackageBuilder
	WithVCS(string) SourcePackageBuilder
	WithEpoch(uint32) SourcePackageBuilder
	WithoutEpoch() SourcePackageBuilder
	WithBuildTime(time.Time) SourcePackageBuilder
	WithPrefixes(...string) SourcePackageBuilder
	WithCompressor(Compressor) SourcePackageBuilder
	WithFileDigestAlgo(DigestAlgo) SourcePackageBuilder
	WithPayloadDigestAlgo(DigestAlgo) SourcePackageBuilder
	WithExcludeArch(...string) SourcePackageBuilder
	WithExclusiveArch(...string) SourcePackageBuilder
	WithExcludeOS(...string) SourcePackageBuilder
	WithExclusiveOS(...string) SourcePackageBuilder
	WithBuildArchs(...string) SourcePackageBuilder
	WithOptFlags(string) SourcePackageBuilder
	WithPlatform(string) SourcePackageBuilder
	WithReservedSignatureSpace(n int) SourcePackageBuilder
	WithTempDir(string) SourcePackageBuilder
	WithSigner(Signer) SourcePackageBuilder
	WithPGPSignFunc(func([]byte) ([]byte, error)) SourcePackageBuilder
	AllowListDirs(...string) SourcePackageBuilder
	AddCustomTag(tag int, e IndexEntry) SourcePackageBuilder
	AddCustomSig(tag int, e IndexEntry) SourcePackageBuilder

	// Files and harvesting (sub-builders return the base PackageBuilder).
	WithFile(name string, body []byte) FileBuilder
	WithFileFromPath(rpmPath, diskPath string) FileBuilder
	File(name string) FileBuilder
	AddTree(fsys fs.FS, prefix string) error
	AddTar(r io.Reader) error

	// Dependency, scriptlet, trigger, and changelog sub-builders.
	Provides() RelationSetBuilder
	Requires() RelationSetBuilder
	Conflicts() RelationSetBuilder
	Obsoletes() RelationSetBuilder
	Recommends() RelationSetBuilder
	Suggests() RelationSetBuilder
	Supplements() RelationSetBuilder
	Enhances() RelationSetBuilder
	OrderWithRequires() RelationSetBuilder
	Pretrans() ScriptletBuilder
	Prein() ScriptletBuilder
	Postin() ScriptletBuilder
	Preun() ScriptletBuilder
	Postun() ScriptletBuilder
	Posttrans() ScriptletBuilder
	VerifyScript() ScriptletBuilder
	Trigger(TriggerKind) TriggerBuilder
	Changelog() ChangelogBuilder

	Build() (Package, error)
}

// srcBuilder backs SourcePackageBuilder. It embeds *rpmPackage so the file,
// dependency, scriptlet, harvesting, and Build methods are promoted unchanged;
// the scalar setters below shadow the promoted ones to return
// SourcePackageBuilder for source-typed chaining.
type srcBuilder struct {
	*rpmPackage
}

func (s *srcBuilder) WithSpecFile(name string, body []byte) SourcePackageBuilder {
	fe := s.fileFor(name)
	fe.body, fe.open, fe.size = body, nil, 0
	fe.ftype |= SpecFile
	fe.owner, fe.group = "root", "root"
	s.specFile = fe
	return s
}

func (s *srcBuilder) WithSource(name string, body []byte) SourcePackageBuilder {
	fe := s.fileFor(name)
	fe.body, fe.open, fe.size = body, nil, 0
	fe.owner, fe.group = "root", "root"
	s.sources = append(s.sources, name)
	return s
}

func (s *srcBuilder) WithSourceFromPath(name, diskPath string) SourcePackageBuilder {
	fe := s.fileFor(name)
	s.setFromPath(fe, diskPath)
	fe.owner, fe.group = "root", "root"
	s.sources = append(s.sources, name)
	return s
}

func (s *srcBuilder) WithPatch(name string, body []byte) SourcePackageBuilder {
	fe := s.fileFor(name)
	fe.body, fe.open, fe.size = body, nil, 0
	fe.owner, fe.group = "root", "root"
	s.patches = append(s.patches, name)
	return s
}

func (s *srcBuilder) WithPatchFromPath(name, diskPath string) SourcePackageBuilder {
	fe := s.fileFor(name)
	s.setFromPath(fe, diskPath)
	fe.owner, fe.group = "root", "root"
	s.patches = append(s.patches, name)
	return s
}

func (s *srcBuilder) WithExcludedSource(index int) SourcePackageBuilder {
	s.noSources = append(s.noSources, int32(index))
	return s
}

func (s *srcBuilder) WithExcludedPatch(index int) SourcePackageBuilder {
	s.noPatches = append(s.noPatches, int32(index))
	return s
}

// Scalar-setter overrides keep the chain typed as SourcePackageBuilder.
func (s *srcBuilder) WithName(v string) SourcePackageBuilder { s.rpmPackage.WithName(v); return s }
func (s *srcBuilder) WithVersion(v string) SourcePackageBuilder {
	s.rpmPackage.WithVersion(v)
	return s
}
func (s *srcBuilder) WithRelease(v string) SourcePackageBuilder {
	s.rpmPackage.WithRelease(v)
	return s
}
func (s *srcBuilder) WithSummary(v string) SourcePackageBuilder {
	s.rpmPackage.WithSummary(v)
	return s
}
func (s *srcBuilder) WithDescription(v string) SourcePackageBuilder {
	s.rpmPackage.WithDescription(v)
	return s
}
func (s *srcBuilder) WithArch(v string) SourcePackageBuilder   { s.rpmPackage.WithArch(v); return s }
func (s *srcBuilder) WithOS(v string) SourcePackageBuilder     { s.rpmPackage.WithOS(v); return s }
func (s *srcBuilder) WithVendor(v string) SourcePackageBuilder { s.rpmPackage.WithVendor(v); return s }
func (s *srcBuilder) WithURL(v string) SourcePackageBuilder    { s.rpmPackage.WithURL(v); return s }
func (s *srcBuilder) WithPackager(v string) SourcePackageBuilder {
	s.rpmPackage.WithPackager(v)
	return s
}
func (s *srcBuilder) WithGroup(v string) SourcePackageBuilder { s.rpmPackage.WithGroup(v); return s }
func (s *srcBuilder) WithLicense(v string) SourcePackageBuilder {
	s.rpmPackage.WithLicense(v)
	return s
}
func (s *srcBuilder) WithBuildHost(v string) SourcePackageBuilder {
	s.rpmPackage.WithBuildHost(v)
	return s
}
func (s *srcBuilder) WithDistribution(v string) SourcePackageBuilder {
	s.rpmPackage.WithDistribution(v)
	return s
}
func (s *srcBuilder) WithVCS(v string) SourcePackageBuilder   { s.rpmPackage.WithVCS(v); return s }
func (s *srcBuilder) WithEpoch(e uint32) SourcePackageBuilder { s.rpmPackage.WithEpoch(e); return s }
func (s *srcBuilder) WithoutEpoch() SourcePackageBuilder      { s.rpmPackage.WithoutEpoch(); return s }
func (s *srcBuilder) WithBuildTime(t time.Time) SourcePackageBuilder {
	s.rpmPackage.WithBuildTime(t)
	return s
}
func (s *srcBuilder) WithPrefixes(p ...string) SourcePackageBuilder {
	s.rpmPackage.WithPrefixes(p...)
	return s
}
func (s *srcBuilder) WithCompressor(c Compressor) SourcePackageBuilder {
	s.rpmPackage.WithCompressor(c)
	return s
}
func (s *srcBuilder) WithFileDigestAlgo(d DigestAlgo) SourcePackageBuilder {
	s.rpmPackage.WithFileDigestAlgo(d)
	return s
}
func (s *srcBuilder) WithPayloadDigestAlgo(d DigestAlgo) SourcePackageBuilder {
	s.rpmPackage.WithPayloadDigestAlgo(d)
	return s
}
func (s *srcBuilder) WithExcludeArch(a ...string) SourcePackageBuilder {
	s.rpmPackage.WithExcludeArch(a...)
	return s
}
func (s *srcBuilder) WithExclusiveArch(a ...string) SourcePackageBuilder {
	s.rpmPackage.WithExclusiveArch(a...)
	return s
}
func (s *srcBuilder) WithExcludeOS(o ...string) SourcePackageBuilder {
	s.rpmPackage.WithExcludeOS(o...)
	return s
}
func (s *srcBuilder) WithExclusiveOS(o ...string) SourcePackageBuilder {
	s.rpmPackage.WithExclusiveOS(o...)
	return s
}
func (s *srcBuilder) WithBuildArchs(a ...string) SourcePackageBuilder {
	s.rpmPackage.WithBuildArchs(a...)
	return s
}
func (s *srcBuilder) WithOptFlags(v string) SourcePackageBuilder {
	s.rpmPackage.WithOptFlags(v)
	return s
}
func (s *srcBuilder) WithPlatform(v string) SourcePackageBuilder {
	s.rpmPackage.WithPlatform(v)
	return s
}
func (s *srcBuilder) WithReservedSignatureSpace(n int) SourcePackageBuilder {
	s.rpmPackage.WithReservedSignatureSpace(n)
	return s
}
func (s *srcBuilder) WithTempDir(dir string) SourcePackageBuilder {
	s.rpmPackage.WithTempDir(dir)
	return s
}
func (s *srcBuilder) WithSigner(sg Signer) SourcePackageBuilder {
	s.rpmPackage.WithSigner(sg)
	return s
}
func (s *srcBuilder) WithPGPSignFunc(f func([]byte) ([]byte, error)) SourcePackageBuilder {
	s.rpmPackage.WithPGPSignFunc(f)
	return s
}
func (s *srcBuilder) AllowListDirs(dirs ...string) SourcePackageBuilder {
	s.rpmPackage.AllowListDirs(dirs...)
	return s
}
func (s *srcBuilder) AddCustomTag(tag int, e IndexEntry) SourcePackageBuilder {
	s.rpmPackage.AddCustomTag(tag, e)
	return s
}
func (s *srcBuilder) AddCustomSig(tag int, e IndexEntry) SourcePackageBuilder {
	s.rpmPackage.AddCustomSig(tag, e)
	return s
}
