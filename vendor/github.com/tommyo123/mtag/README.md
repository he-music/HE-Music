# mtag

`mtag` is a Go library for reading and writing audio metadata across
multiple container formats.

It exposes one `File` API for common fields such as title, artist,
album, track, disc, year, genre, comments, lyrics, images,
ReplayGain, MusicBrainz IDs, chapters, podcast fields, and custom
values, while keeping native tag stores available when callers need
format-specific access.

## Install

```bash
go get github.com/tommyo123/mtag
```

Requires Go 1.23 or newer.

## Supported containers

| Container | Read | Write | Native metadata |
|---|:---:|:---:|---|
| MP3 | yes | yes | ID3v1, ID3v2.2-2.4 |
| AAC / ADTS (`.aac`) | yes | yes | prepended ID3v2, optional trailing APEv2 / ID3v1 |
| FLAC | yes | yes | Vorbis Comments, PICTURE, CUESHEET |
| Ogg Vorbis / Opus / Speex / FLAC-in-Ogg | yes | yes | Vorbis Comments, Ogg-FLAC VORBIS_COMMENT |
| MP4 / M4A / M4B | yes | yes | `ilst`, freeform `----:`, native chapters |
| WAV / RIFF / RF64 / BW64 / Wave64 (`.w64`) | yes | yes | `id3 ` chunk, LIST-INFO, BWF |
| AIFF / AIFC | yes | yes | `ID3 ` chunk, NAME / AUTH / ANNO / `(c)` |
| Monkey's Audio (`.ape`) | yes | yes | APEv1, APEv2 |
| TrueAudio (`.tta`) | yes | yes | prepended ID3v2, trailing APEv2 / ID3v1 |
| AC-3 (`.ac3`) | yes | yes | prepended ID3v2, trailing ID3v1 |
| DTS (`.dts`) | yes | yes | prepended ID3v2, trailing ID3v1 |
| AMR / AMR-WB (`.amr`) | yes | yes | prepended ID3v2, trailing ID3v1 |
| WavPack (`.wv`) | yes | yes | APEv2 |
| Musepack SV4 / SV5 / SV7 / SV8 (`.mpc`) | yes | yes | APEv2 |
| TAK (`.tak`) | yes | yes | APEv2 |
| DSF (`.dsf`) | yes | yes | trailing ID3v2 |
| DSDIFF / DFF (`.dff`) | yes | yes | trailing `ID3 ` chunk |
| ASF / WMA | yes | yes | Content Description, Metadata objects, `WM/Picture` |
| Matroska / WebM (`.mka`, `.mkv`, `.webm`) | yes | yes | Segment title, SimpleTag, attachments, chapters |
| RealAudio / RealMedia (`.ra`, `.rm`) | yes | yes | CONT metadata |
| Tracker modules (`.mod`, `.s3m`, `.xm`, `.it`) | yes | yes | native title, comment, and tracker-name fields |
| Core Audio Format (`.caf`) | yes | yes | `info` chunk |
| OpenMG / ATRAC (`.oma`, `.aa3`, `.at3`) | yes | yes | ID3v2 behind `ea3`, typed `OMG_*` helpers |

Formats not listed in the table are unsupported.

## Quick start

```go
package main

import (
	"fmt"
	"log"

	"github.com/tommyo123/mtag"
)

func main() {
	f, err := mtag.Open("song.mp3")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	fmt.Println("title:", f.Title())
	fmt.Println("artist:", f.Artist())
	fmt.Println("album:", f.Album())
	fmt.Println("track:", f.Track(), "/", f.TrackTotal())

	f.SetAlbum("Remastered")
	f.SetTrack(2, 12)
	f.SetGenre("Rock")

	if err := f.Save(); err != nil {
		log.Fatal(err)
	}
}
```

## Opening files and streams

Use `Open` for filesystem paths:

```go
f, err := mtag.Open("song.flac")
```

Use `OpenSource` for a read-only `io.ReaderAt`:

```go
f, err := mtag.OpenSource(r, size)
```

Use `OpenWritableSource` when the source also supports `WriteAt` and
`Truncate`:

```go
f, err := mtag.OpenWritableSource(src, size)
```

`OpenBytes` is a convenience wrapper for `[]byte`.

`File` is not safe for concurrent use.

## Public API

See [`API.md`](API.md) for the full reference. The top-level `File` API is
grouped around a small set of concepts.

- Common text fields: `Title`, `Artist`, `Album`, `AlbumArtist`,
  `Composer`, `Comment`, `Lyrics`, `Copyright`, `Publisher`,
  `EncodedBy`.
- Numbering and dates: `Track`, `TrackTotal`, `Disc`, `DiscTotal`,
  `Year`, `RecordingTime`.
- Flags and counters: `IsCompilation`, `PlayCount`, `Rating`,
  `RatingEmail`.
- Images: `Images`, `ImageSummaries`, `AddImage`, `SetCoverArt`,
  `RemoveImages`.
- Structured metadata: `ReplayGainTrack`, `ReplayGainAlbum`,
  `MusicBrainzID`, `CustomValues`, `Chapters`, `InvolvedPeople`,
  `MusicianCredits`, `ITunesNormalisation`.
- Podcast fields: `Podcast`, `PodcastCategory`,
  `PodcastDescription`, `PodcastIdentifier`, `PodcastFeedURL`.
- Native container extras: `Attachments`, `CueSheet`,
  `BroadcastWave`, `OpenMG`.

`APEv2()` can also expose trailing APE tags on raw audio files that
carry them, such as `TTA` and `AAC/ADTS`.

Use `RemoveField(FieldKey)` to clear one mapped field and
`RemoveTag(TagKind)` to drop one native store from the in-memory file
state before saving.

Reads prefer the native store selected for the active container. For
MP3-family files with both ID3v2 and ID3v1, ID3v2 is the preferred read
source and ID3v1 is derived from the ID3v2 view on save.

`Chapters()` reads ID3v2 `CHAP`, MP4 native chapters, Matroska
chapters, VorbisComment `CHAPTER###` tags in FLAC/Ogg, and WAV or
Wave64 `cue `/`LIST-adtl/labl` chapter markers when present.

## Audio properties

`AudioProperties()` reports stream-level data such as codec, duration,
bitrate, sample rate, channels, and bit depth when the container
exposes them.

```go
props := f.AudioProperties()
fmt.Println(props.Codec, props.Duration, props.SampleRate)
```

Formats with fixed headers read those headers directly. Stream-oriented
formats such as MPEG audio, ADTS AAC, and Ogg support three read
styles:

- `AudioPropertiesAccurate`
- `AudioPropertiesAverage`
- `AudioPropertiesFast`

Select the style with `WithAudioPropertiesStyle(...)` at open time.

`ReplayGainTrack()` and `ReplayGainAlbum()` prefer explicit tag stores
first. On MP3 files they also fall back to the LAME/Xing summary block
when it carries ReplayGain data with a valid tag CRC.

## Saving

`Save()` preserves the tag families already present on disk and writes
back the current in-memory state.

`SaveContext(ctx)` is the cancellable variant.

`SaveFormats(...)` is the exact-format write API for ID3-backed
containers. `SaveWith(...)` is a compatibility alias.

```go
if err := f.SaveFormats(mtag.FormatID3v23); err != nil {
	log.Fatal(err)
}
```

Path-backed opens use in-place patching when possible and otherwise
rewrite through a sibling temporary file before replacing the original.
Path-backed rewrite flows preserve the original file mode bits and
modified time. On Linux they also copy xattrs onto the sibling temp
file before replacement on a best-effort basis.

`OpenWritableSource` uses the same staging step, then copies the
rebuilt bytes back through `WriteAt` and `Truncate`. This avoids
buffering the full rebuilt file in memory, but the final replacement is
not atomic.

## Options

Useful open options:

- `WithReadOnly()`
- `WithSkipV1()`
- `WithSkipV2()`
- `WithSkipPictures()`
- `WithSkipAttachments()`
- `WithLeadingJunkScan(maxBytes)`
- `WithSyncV1toV2()`
- `WithCreateV2OnV1Only()`
- `WithGenreSyncStrategy(...)`
- `WithPaddingBudget(bytes)`
- `WithMaxFileSize(bytes)`
- `WithAudioPropertiesStyle(...)`

`WithSkipPictures()` and `WithSkipAttachments()` are read-side memory
optimisations. Saving a file opened with those options writes back the
reduced in-memory view.

Tracker modules expose native title, comment, and tracker-name fields.
They do not expose native custom fields.

## Capabilities and errors

Use `Capabilities()` to inspect whether a feature family is readable or
writable before mutating:

```go
caps := f.Capabilities()
if caps.Images.Write {
	fmt.Println("image writes supported")
}
```

Most setters do not return an error directly. When a value cannot be
represented in the current writable store, the setter records a
recoverable error:

```go
f.SetAlbumArtist("Band Name")
if err := f.Err(); err != nil {
	log.Println(err)
	f.ResetErr()
}
```

Use the error paths this way:

- `Err()` / `Errs()` for recoverable setter-time problems
- `Save()` / `SaveContext()` for immediate I/O or rewrite failures
- `ResetErr()` to clear the recoverable accumulator

## Native stores

Use the native accessors when the polymorphic API is not enough:

- `ID3v1()`
- `ID3v2()`
- `APEv2()`
- `Tags()`
- `Tag(kind)`

`V1()`, `V2()`, and `APE()` remain available as compatibility aliases.

The subpackages `id3v1`, `id3v2`, `flac`, `mp4`, and `ape` expose the
corresponding native types and encoders.

## Command-line tool

```bash
go install github.com/tommyo123/mtag/cmd/mtag@latest

mtag show  song.mp3
mtag set   song.mp3 title="New Title" year=2024 track=3/12
mtag cover song.mp3 cover.jpg         # set (cover.jpg exists) or extract (does not)
mtag strip song.mp3 v1
mtag copy  src.mp3 dst.mp3            # both files must already exist
mtag diff  a.mp3 b.mp3
```

Run `mtag` with no arguments for the full subcommand list.

## Examples

Standalone example programs live under `examples/`:

- [`examples/read`](examples/read) – print every field, image summary,
  and audio property for a file.
- [`examples/write`](examples/write) – set the common text fields and
  numbering, then save.
- [`examples/images`](examples/images) – list embedded images or
  replace the front cover.
- [`examples/chapters`](examples/chapters) – read, set, or clear
  chapter markers.

Package-level `Example*` tests in the repo root render as runnable
examples on [pkg.go.dev](https://pkg.go.dev/github.com/tommyo123/mtag).

## Stability

The current codebase is intended for the first stable release. The
supported containers in the table above have read and write support in
the current tree, and the public API is meant to remain stable across
the initial `v1` line.

- [`API.md`](API.md) – full public API reference.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) – internal layout.
- [`CHANGELOG.md`](CHANGELOG.md) – release history.

