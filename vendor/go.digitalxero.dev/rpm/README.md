# go.digitalxero.dev/rpm

A pure-Go library for building RPM packages — binary `.rpm` and source `.src.rpm`
— with OpenPGP signing. No `rpmbuild`, no spec files, no CGO, so it runs on any
platform Go targets. Output is deterministic and reproducible, and is verified
both by an independent in-package decoder and against the real `rpm` toolchain.

It supports everything [`github.com/google/rpmpack`](https://github.com/google/rpmpack)
does and adds the features it omits, redesigned around a typed builder API.

## Features

- **Binary and source packages** — `NewPackage` and `NewSourcePackage`.
- **Files** — regular, config, doc, ghost, license/readme, directories, and
  symlinks; per-file owner/group/mode/mtime, capabilities, lang, color, file
  class (`CLASSDICT`/`FILECLASS`), and file-level provides/requires
  (`DEPENDSDICT`).
- **Dependencies** — requires, provides, conflicts, obsoletes, recommends,
  suggests, supplements, enhances, and install order; version senses, phase
  qualifiers (`Requires(pre)`/`(post)`/…), and rich/boolean deps (`(foo if bar)`).
  The standard `rpmlib()` feature requirements are added automatically.
- **Build/install metadata** — exclude/exclusive arch and OS, build archs,
  optflags, and platform.
- **Scriptlets** — pretrans/prein/postin/preun/postun/posttrans and verify, each
  with a configurable interpreter.
- **Triggers and changelog.**
- **Digests** — file and payload digests in SHA-256 (default), SHA-1, SHA-384,
  SHA-512, or MD5.
- **Compression** — gzip (default, standard library), xz, lzma, zstd.
- **Signing** — built-in OpenPGP signer (via
  [`github.com/ProtonMail/go-crypto`](https://github.com/ProtonMail/go-crypto)),
  producing the header and header+payload signatures plus SHA-256/SHA-1/MD5
  digests, with optional reserved space for in-place re-signing; or a low-level
  sign-func escape hatch.
- **Streaming** — file content is streamed from disk (or any reader), and the
  compressed payload is spooled to a temp file, so building a multi-gigabyte
  package needs only a small, bounded amount of memory.
- **64-bit sizes** automatically for packages or files larger than 4 GiB.
- **Custom tags** for anything not covered by the typed API.
- **Deterministic, reproducible** output.

All public types follow a Builder-IS-Implementation pattern: a `New*` constructor
returns a chainable builder whose `Build` returns the runtime interface.

Binary and source packages set `RPMVERSION` to the deterministic producer
identity `go.digitalxero.dev/rpm`. This prevents a Lua scriptlet installation
crash in RPM 6.0.1 when that header is missing. It does not claim an upstream
`rpmbuild` version or depend on the host's installed RPM tools. `AddCustomTag`
can override it when an application needs its own producer metadata.

## Non-goals

Delta/patch RPMs, spec-file parsing and macro expansion, rpmdb interaction or
installation/transaction logic, the `tar2rpm` CLI, and emitting OpenPGP v6
signatures by default are out of scope. For MSI and MSIX packaging, see the
companion modules [go-msi](https://go.digitalxero.dev/go-msi) and
[go-msix](https://go.digitalxero.dev/go-msix).

## Install

```sh
go get go.digitalxero.dev/rpm
```

## Usage

```go
b := rpm.NewPackage().
	WithName("hello").
	WithVersion("1.0").
	WithRelease("1").
	WithSummary("a greeting").
	WithDescription("says hello").
	WithLicense("MIT").
	WithArch("x86_64")

b.WithFile("/usr/bin/hello", scriptBytes).WithMode(0o755).Add()
b.WithFile("/etc/hello.conf", confBytes).WithType(rpm.ConfigFile).Add()
b.File("/usr/bin/hi").WithSymlink("/usr/bin/hello").Add()

b.Requires().AddParsed("bash >= 4.0").Done()
b.Postin().WithScript("echo installed").Done()

pkg, err := b.Build()
if err != nil {
	log.Fatal(err)
}
out, _ := os.Create("hello-1.0-1.x86_64.rpm")
defer out.Close()
if _, err := pkg.WriteTo(out); err != nil {
	log.Fatal(err)
}
```

### Adding a file tree

```go
b.AddTree(os.DirFS("staging"), "/opt/app") // harvest a directory (streamed)
b.AddTar(tarReader)                          // or a tar stream
```

### Large files (streaming)

Use `WithFileFromPath` (or `File(name).FromPath/WithReader/WithOpener`) to stream
content from disk instead of loading it into memory:

```go
b.WithFileFromPath("/usr/share/app/data.bin", "/build/out/data.bin").WithMode(0o644).Add()
```

The compressed payload is spooled to a temp file while writing. If your temp dir
is RAM-backed (tmpfs), point the spool at real disk with
`b.WithTempDir("/var/tmp")`. Path-based sources are re-read on each write, so the
package stays reproducible; a one-shot `WithReader` source can only be written
once.

## Source packages

The source-specific methods return `SourcePackageBuilder`, so they come first in
the chain; the shared metadata setters follow:

```go
pkg, err := rpm.NewSourcePackage().
	WithSpecFile("hello.spec", specBytes).
	WithSource("hello-1.0.tar.gz", tarballBytes).
	WithPatch("0001-fix.patch", patchBytes).
	WithName("hello").
	WithVersion("1.0").
	WithRelease("1").
	WithLicense("MIT").
	Build()
```

The result sets `SOURCEPACKAGE`, omits `SOURCERPM`, uses arch `src`, lays the
payload out flat, and flags the spec file — a proper `.src.rpm`.

## Signing

```go
signer, err := rpm.NewSigner().
	WithKeyFile("private.asc"). // armored or binary; WithArmoredKey also works
	WithPassphrase("secret").
	WithSigningTime(buildTime).  // fix for reproducible signatures
	Build()
if err != nil {
	log.Fatal(err)
}

pkg, err := rpm.NewPackage().
	WithName("hello").WithVersion("1.0").WithLicense("MIT").
	WithSigner(signer).
	Build()
```

`rpm -K` on the result reports the header signature, header digest, payload
digest, and header+payload signature all OK once the public key is imported.

For full control over the produced bytes, use `WithPGPSignFunc` instead.

## Compression

```go
b.WithCompressor(rpm.ZstdCompressor(19)) // or GzipCompressor(9), XzCompressor(), LzmaCompressor()
```

gzip is the default and uses only the standard library.

## Verification

- `go test ./...` runs unit tests plus an in-package round-trip decoder that
  reads every generated package back and checks the tags, digests, and payload —
  an independent code path from the encoder.
- `go test -tags rpmcli ./...` additionally shells out to a native `rpm` to
  cross-check metadata, file lists, dependencies, and `rpm -K`. These tests skip
  when `rpm` is not installed.
- `task verify-rpm` cross-checks generated packages against the real toolchain
  using a native `rpm` or a Fedora container (podman/docker), including a test
  install.
- `task verify-rpm-lua` runs the native integration tests, including Lua install,
  verify, and removal scriptlets, in a disposable container with RPM 6.0.1.
  It requires podman or docker and fails if the exact toolchain is unavailable.
- `task verify-rpm-lua-matrix` checks RPM 4.19.1.1, 6.0.1, and 6.0.2.
- `task verify` includes the pinned Lua regression alongside unit tests, build,
  lint, and the general RPM cross-check.

## Requirements

Go 1.26 or newer.

## License

See [LICENSE](LICENSE).
