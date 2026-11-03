# Architecture

`mtag` is organised around four layers:

1. Container detection
2. Native metadata stores
3. The polymorphic `*File` API
4. Save and rewrite paths

## Detection

`Open`, `OpenSource`, and `OpenWritableSource` create a `File`, bind a
source, and call `detect`.

Detection identifies the outer container first: MP3, FLAC, MP4, Ogg,
RIFF/AIFF/Wave64, ASF, Matroska, APE-native formats, TAK, tracker
modules, and the other supported wrappers. Each container owns its own
detection and save logic through the internal `Container` interface.

The top layer does not parse every format directly. It delegates to the
container back-end and keeps only the state needed for the public API,
audio-property parsing, and save orchestration.

## Native Stores

Each container maps to one or more native metadata stores:

- MP3-family containers use ID3v2 and optionally ID3v1.
- FLAC and Ogg-family containers use Vorbis-style comments, pictures,
  and related blocks.
- MP4 uses `ilst`, freeform items, and native chapter atoms.
- APE-native containers use APEv2.
- RIFF, AIFF, Wave64, ASF, Matroska, CAF, RealMedia, TAK, and tracker
  formats keep small native views for the fields the top layer needs.

The cached native views on `File` are parse results plus writable
working copies. After a successful save, the caches are cleared and the
file is detected again so the in-memory state matches the bytes on
disk.

## Polymorphic API

The public `*File` API exposes common fields such as title, artist,
album, track, disc, year, genre, comment, lyrics, images, ReplayGain,
MusicBrainz IDs, chapters, attachments, and custom fields.

Each accessor prefers the native store selected for the active
container. When a field cannot be represented in that container's
writable stores, the setter records a recoverable error through
`Err()` / `Errs()` instead of failing every call directly.

Native accessors such as `ID3v2()`, `ID3v1()`, `APEv2()`, and
`Tag(kind)` remain available for callers that need store-specific
control.

`AudioProperties()` runs on demand and caches its result on `File`.
Formats with fixed headers read those headers directly. Stream-oriented
formats such as MPEG audio, ADTS AAC, and Ogg use the
`AudioPropertiesStyle` policy to choose between header-only reads,
bounded scans, and full scans.

## Save Flow

`Save` and `SaveFormats` operate in four stages:

1. Validate the writable source and current state.
2. Let the active container persist its metadata.
3. Refresh the bound source handle if a rewrite replaced the file.
4. Clear cached views and run detection again.

Containers use the simplest safe strategy available:

- patch in place when the on-disk layout permits it
- rewrite to a temporary sibling file when the container must be
  rebuilt
- stage to a temporary file and copy back through `WriteAt` /
  `Truncate` for custom writable sources

This keeps the container-specific byte layout logic out of the public
API while still allowing a single `Save` entry point.
