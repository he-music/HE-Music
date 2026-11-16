// Package rpm builds RPM package files entirely in Go — no rpmbuild, no spec
// files, no CGO — so it runs on any platform Go targets. Output is deterministic
// and reproducible, and is cross-checked both by an independent in-package decoder
// and (optionally) by the real rpm/rpmlint toolchain.
//
// # Overview
//
// An RPM is four concatenated parts: a legacy 96-byte lead, a signature header, an
// immutable main header, and a compressed cpio payload. This package writes that
// format directly: the header index encoder (with rpm's region/immutable trailer
// and integer alignment), the newc cpio payload, gzip/xz/lzma/zstd compression,
// and the digest and OpenPGP signature tags.
//
// # Entry points
//
//   - [NewPackage] builds a binary .rpm: metadata, files (regular, config, doc,
//     ghost, directories, symlinks), dependency relations (requires, provides,
//     conflicts, obsoletes, recommends, suggests, supplements, enhances, order),
//     lifecycle scriptlets, triggers, a changelog, and custom tags.
//   - [NewSourcePackage] builds a source .src.rpm: a spec file plus sources and
//     patches, with the correct source-package tagging.
//   - [NewSigner] builds an OpenPGP signer; attach it with
//     [PackageBuilder.WithSigner]. [PackageBuilder.WithPGPSignFunc] is a
//     lower-level escape hatch.
//   - [ParseRelation] parses dependency specs such as "bash >= 4.0" and rich
//     boolean dependencies such as "(foo if bar)".
//
// All public types follow a Builder-IS-Implementation pattern: the builder
// returned by a New* constructor is chainable and its Build method returns the
// runtime [Package].
//
// # Quick start
//
//	b := rpm.NewPackage().
//		WithName("hello").
//		WithVersion("1.0").
//		WithRelease("1").
//		WithSummary("a greeting").
//		WithLicense("MIT").
//		WithArch("x86_64")
//	b.WithFile("/usr/bin/hello", scriptBytes).WithMode(0o755).Add()
//	b.Requires().AddParsed("bash >= 4.0").Done()
//
//	pkg, err := b.Build()
//	if err != nil {
//		// handle error
//	}
//	out, _ := os.Create("hello-1.0-1.x86_64.rpm")
//	defer out.Close()
//	_, _ = pkg.WriteTo(out)
//
// For source packages, the source-specific methods return [SourcePackageBuilder]
// and so come first in a chain, with the shared metadata setters after:
//
//	pkg, err := rpm.NewSourcePackage().
//		WithSpecFile("hello.spec", specBytes).
//		WithSource("hello-1.0.tar.gz", tarBytes).
//		WithName("hello").WithVersion("1.0").WithRelease("1").WithLicense("MIT").
//		Build()
//
// # Streaming large files
//
// File content is streamed rather than buffered: use
// [PackageBuilder.WithFileFromPath] (or [FileBuilder.FromPath] /
// [FileBuilder.WithReader] / [FileBuilder.WithOpener]) and the bytes are read in
// chunks straight into the compressed payload, which is spooled to a temp file on
// disk. Building a multi-gigabyte package therefore uses only a small, bounded
// amount of memory. [PackageBuilder.WithTempDir] controls the spool location
// (set it to real disk if your temp dir is RAM-backed).
//
// # Reproducibility
//
// Files are emitted in sorted order, header tags in tag order, and nothing reads
// the host clock. For bit-reproducible output set [PackageBuilder.WithBuildTime]
// (typically from SOURCE_DATE_EPOCH) and, when signing, a fixed
// [SignerBuilder.WithSigningTime] with an RSA key.
//
// # Non-goals
//
// Delta/patch RPMs, spec-file parsing and macro expansion, rpmdb interaction or
// installation/transaction logic, and emitting OpenPGP v6 signatures by default
// are out of scope. For MSI and MSIX packaging see the companion modules
// go.digitalxero.dev/go-msi and go.digitalxero.dev/go-msix.
package rpm
