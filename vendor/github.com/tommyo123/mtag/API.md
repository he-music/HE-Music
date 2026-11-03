# API Reference

Complete reference for `github.com/tommyo123/mtag`. The authoritative source is
[pkg.go.dev](https://pkg.go.dev/github.com/tommyo123/mtag); this document groups
the surface by topic for quicker orientation.

- [Opening files](#opening-files)
- [Options](#options)
- [Closing and state](#closing-and-state)
- [Text fields](#text-fields)
- [Numbering and dates](#numbering-and-dates)
- [Genre](#genre)
- [Comment and lyrics](#comment-and-lyrics)
- [Images](#images)
- [Chapters](#chapters)
- [Custom fields](#custom-fields)
- [ReplayGain](#replaygain)
- [MusicBrainz](#musicbrainz)
- [Podcast fields](#podcast-fields)
- [Rating and play count](#rating-and-play-count)
- [Compilation](#compilation)
- [iTunes normalisation](#itunes-normalisation)
- [Involved people](#involved-people)
- [Saving](#saving)
- [Removal](#removal)
- [Errors](#errors)
- [Native stores](#native-stores)
- [Container-specific accessors](#container-specific-accessors)
- [Audio properties](#audio-properties)
- [Capabilities](#capabilities)
- [Types](#types)
- [Constants](#constants)
- [Subpackages](#subpackages)

## Opening files

| Function | Purpose |
|---|---|
| `Open(path string, opts ...OpenOption) (*File, error)` | Open a filesystem path. Writable by default unless `WithReadOnly()` is passed. |
| `OpenSource(src io.ReaderAt, size int64, opts ...OpenOption) (*File, error)` | Open a generic read-only source. |
| `OpenWritableSource(src WritableSource, size int64, opts ...OpenOption) (*File, error)` | Open a generic source with `WriteAt` + `Truncate`. |
| `OpenBytes(data []byte, opts ...OpenOption) (*File, error)` | Convenience wrapper for in-memory byte slices. |

## Options

All options are values of type `OpenOption` and may be combined.

| Option | Effect |
|---|---|
| `WithReadOnly()` | Forbid save paths. |
| `WithSkipV1()` | Do not parse the ID3v1 footer. |
| `WithSkipV2()` | Do not parse any ID3v2 tag. |
| `WithSkipPictures()` | Discard embedded pictures immediately after parsing. |
| `WithSkipAttachments()` | Discard Matroska attachments immediately after parsing. |
| `WithLeadingJunkScan(maxBytes int64)` | Scan up to `maxBytes` for a prepended ID3v2 tag. |
| `WithSyncV1toV2()` | Promote a v1-only file to v2 at open. |
| `WithCreateV2OnV1Only()` | Allow v2-exclusive setters to create a v2 tag on a v1-only file. |
| `WithGenreSyncStrategy(GenreSyncStrategy)` | Control how free-form v2 genres map onto the v1 genre byte. |
| `WithPaddingBudget(bytes int64)` | Control the padding written after ID3v2 tags. |
| `WithMaxFileSize(maxBytes int64)` | Reject files larger than `maxBytes` at open. |
| `WithAudioPropertiesStyle(AudioPropertiesStyle)` | Trade scan depth for speed in MPEG / AAC / Ogg readers. |

## Closing and state

| Method | Description |
|---|---|
| `Close() error` | Release the underlying handle and cached metadata. |
| `Path() string` | Return the path the file was opened from. |
| `Writable() bool` | Report whether the file has read/write access. |
| `Container() ContainerKind` | Report the detected container kind. |
| `Formats() Format` | Report which ID3 format families are present. |

## Text fields

Every getter prefers the richest available store (ID3v2, then Vorbis, MP4, APE,
Matroska, RIFF/INFO, ID3v1) and returns `""` when no store carries a value.
Setters write to every store currently present on the file.

| Getter | Setter |
|---|---|
| `Title() string` | `SetTitle(string)` |
| `Artist() string` | `SetArtist(string)` |
| `Album() string` | `SetAlbum(string)` |
| `AlbumArtist() string` | `SetAlbumArtist(string)` |
| `Composer() string` | `SetComposer(string)` |
| `Copyright() string` | `SetCopyright(string)` |
| `Publisher() string` | `SetPublisher(string)` |
| `EncodedBy() string` | `SetEncodedBy(string)` |

## Numbering and dates

| Getter | Setter | Notes |
|---|---|---|
| `Track() int` | `SetTrack(track, total int)` | `total=0` omits the total part. |
| `TrackTotal() int` | — | Derived from the track/total pair. |
| `Disc() int` | `SetDisc(disc, total int)` | Same semantics as `SetTrack`. |
| `DiscTotal() int` | — | |
| `Year() int` | `SetYear(int)` | `SetYear(0)` clears the field. |
| `RecordingTime() (time.Time, bool)` | — | Parses the full TDRC timestamp when available. |

## Genre

| Method | Description |
|---|---|
| `Genre() string` | Resolves `(N)` ID3v1 references and common numeric encodings to readable names. |
| `SetGenre(string)` | Writes the raw string to every store present. |

## Comment and lyrics

| Method | Description |
|---|---|
| `Comment() string` | The first non-empty comment across stores. |
| `SetComment(string)` | Passing `""` clears the field. |
| `Lyrics() string` | First USLT / LYRICS field. |
| `SetLyrics(string)` | Multi-line strings are preserved verbatim. |

## Images

| Method | Description |
|---|---|
| `Images() []Picture` | Full picture list with payload bytes. |
| `ImageSummaries() []ImageSummary` | Lightweight (type, MIME, size) summaries. |
| `AddImage(Picture)` | Append a picture to the active writable store. |
| `SetCoverArt(mime string, data []byte)` | Replace the front cover with a JPEG / PNG payload. |
| `RemoveImages()` | Drop every embedded picture. |

## Chapters

| Method | Description |
|---|---|
| `Chapters() []Chapter` | Native chapter markers from ID3v2 CHAP, MP4, Matroska, Vorbis `CHAPTER###`, or WAV `cue`. |
| `SetChapters([]Chapter) error` | Replace the chapter set. |
| `RemoveChapters() error` | Drop all chapters. |

## Custom fields

| Method | Description |
|---|---|
| `CustomValue(name string) string` | First value of a custom field. |
| `CustomValues(name string) []string` | Full list of values. |
| `SetCustomValues(name string, values ...string)` | Replace the list; empty `values` removes the field. |
| `RemoveCustom(name string)` | Drop the field from every store. |

## ReplayGain

| Method | Description |
|---|---|
| `ReplayGainTrack() (ReplayGain, bool)` | Track-level gain/peak. |
| `ReplayGainAlbum() (ReplayGain, bool)` | Album-level gain/peak. |
| `SetReplayGainTrack(ReplayGain)` | `NaN` in either field removes that entry. |
| `SetReplayGainAlbum(ReplayGain)` | Same semantics as `SetReplayGainTrack`. |

## MusicBrainz

| Method | Description |
|---|---|
| `MusicBrainzID(MusicBrainzField) string` | Read a MusicBrainz identifier. |
| `SetMusicBrainzID(MusicBrainzField, string)` | Passing `""` removes the identifier. |

## Podcast fields

| Method | Description |
|---|---|
| `Podcast() bool` | Whether the iTunes PCST flag is set. |
| `SetPodcast(bool)` | Toggle the PCST flag. |
| `PodcastCategory() string` / `SetPodcastCategory(string)` | TCAT. |
| `PodcastDescription() string` / `SetPodcastDescription(string)` | TDES. |
| `PodcastIdentifier() string` / `SetPodcastIdentifier(string)` | TGID. |
| `PodcastFeedURL() string` / `SetPodcastFeedURL(string)` | WFED. |

## Rating and play count

| Method | Description |
|---|---|
| `Rating() byte` | POPM rating in 0-255. |
| `RatingEmail() string` | The rater identifier stored in POPM. |
| `SetRating(email string, rating byte)` | `email=""` and `rating=0` clears the frame when no play count is present. |
| `PlayCount() uint64` | PCNT value. |
| `SetPlayCount(uint64)` | `0` removes the count; the POPM frame is preserved when it carries a rating. |

## Compilation

| Method | Description |
|---|---|
| `IsCompilation() bool` | Reports the iTunes `cpil` / ID3 TCMP flag. |
| `SetCompilation(bool)` | Toggles the flag. |

## iTunes normalisation

| Method | Description |
|---|---|
| `ITunesNormalisation() (ITunesNormalisation, bool)` | Parsed payload of the iTunes `iTunNORM` COMM frame. |

## Involved people

| Method | Description |
|---|---|
| `InvolvedPeople() []Credit` | Parsed TIPL / IPLS credits. |
| `MusicianCredits() []Credit` | Parsed TMCL credits. |

## Saving

| Method | Description |
|---|---|
| `Save() error` | Persist the in-memory state, preserving the tag families present on disk. |
| `SaveContext(ctx context.Context) error` | Cancellable variant of `Save`. |
| `SaveFormats(want Format) error` | Exact-format API for ID3-backed containers. |
| `SaveWith(want Format) error` | Deprecated alias for `SaveFormats`. |

Path-backed rewrites preserve the file mode, modification time, and (on Linux)
extended attributes. Rewrites stage bytes in a sibling temp file and end with
an atomic rename on Unix; Windows falls back to a stream-back when another
process holds the target open.

## Removal

| Method | Description |
|---|---|
| `RemoveField(FieldKey) error` | Clear one mapped field across every writable store. |
| `RemoveTag(TagKind) error` | Drop one native tag store from the in-memory state. |
| `RemoveImages()` | Drop every embedded picture. |
| `RemoveChapters() error` | Drop every chapter. |
| `RemoveCustom(name string)` | Drop a custom field. |

## Errors

| Method | Description |
|---|---|
| `Err() error` | First recoverable setter error. |
| `Errs() []error` | Full list of recoverable errors. |
| `ResetErr()` | Clear the recoverable accumulator. |

Package errors:

- `ErrNoTag` - tag not present.
- `ErrUnsupportedFormat` - unrecognised container.
- `ErrUnsupportedOperation` - operation not meaningful for this container.
- `ErrInvalidTag` - tag bytes do not match the format spec.
- `ErrUnsupportedVersion` - tag version not understood.
- `ErrReadOnly` - mutation attempted on a read-only file.
- `ErrFileTooLarge` - `WithMaxFileSize` rejected the open.
- `ErrContainerWriteUnsupported` - read-only container.
- `ErrMP4NoRoom` - MP4 in-place patch cannot fit the new ilst body.

## Native stores

| Method | Description |
|---|---|
| `ID3v1() *id3v1.Tag` | Raw v1 footer (or `nil`). |
| `ID3v2() *id3v2.Tag` | Raw v2 tag (or `nil`). |
| `APEv2() *ape.Tag` | Raw APE tag (or `nil`). |
| `V1()`, `V2()`, `APE()` | Deprecated aliases. |
| `Tag(TagKind) Tag` | Polymorphic read-only view for one store. |
| `Tags() []Tag` | All stores present, in priority order. |

## Container-specific accessors

| Method | Container | Description |
|---|---|---|
| `Attachments() []Attachment` | Matroska | Full attachment list with payload bytes. |
| `AttachmentSummaries() []AttachmentSummary` | Matroska | Lightweight summaries. |
| `CueSheet() *flac.CueSheet` | FLAC | Parsed CUESHEET block. |
| `BroadcastWave() *BroadcastWave` | WAV | BWF bext / iXML / aXML / cart / UMID. |
| `SetBroadcastExtension(*BroadcastExtension)` | WAV | Write the BWF bext chunk. |
| `SetBWFIXML(string)` / `SetBWFAXML(string)` / `SetBWFCart(*CartChunk)` / `SetBWFUMID([]byte)` | WAV | Write individual BWF chunks. |
| `OpenMG() *OpenMGMetadata` | OMA / ATRAC | OpenMG descriptor block. |
| `SetOpenMGTrack(string)` / `SetOpenMGAlbumArtist(string)` / `SetOpenMGAlbumGenre(string)` | OMA | Typed OMG helpers. |
| `SetOpenMGObject(OpenMGObject)` | OMA | Write an arbitrary OMG object. |
| `RemoveOpenMGObject(name string)` | OMA | Drop an OMG object. |

## Audio properties

```go
type AudioProperties struct {
    Duration   time.Duration
    Bitrate    int // bits per second; 0 when unknown
    SampleRate int // Hz
    Channels   int
    BitDepth   int // bits per sample; 0 when unknown or not applicable
    Codec      string
}
```

| Method | Description |
|---|---|
| `AudioProperties() AudioProperties` | Parse the stream headers. Cached on the `File`. |

Style selectors (`WithAudioPropertiesStyle`):

- `AudioPropertiesAccurate` - full scan.
- `AudioPropertiesAverage` - bounded scan with summary-block fallback.
- `AudioPropertiesFast` - header and summary block only.

## Capabilities

| Method | Description |
|---|---|
| `Capabilities() Capabilities` | Feature matrix for the current file / container. |

```go
type Capabilities struct {
    Container         ContainerKind
    CanSave           bool
    Images            FeatureSupport
    Lyrics            FeatureSupport
    Chapters          FeatureSupport
    CustomFields      FeatureSupport
    ReplayGain        FeatureSupport
    MusicBrainzIDs    FeatureSupport
    NativeAttachments FeatureSupport
    Podcast           FeatureSupport
    Rating            FeatureSupport
    PlayCount         FeatureSupport
}

type FeatureSupport struct {
    Read  bool
    Write bool
}
```

## Types

- `File` - the opened metadata view. Not safe for concurrent use.
- `Picture` - full picture value with type, MIME, description, data.
- `ImageSummary` - type + MIME + size (no data).
- `PictureType` - APIC picture-type byte.
- `Chapter` - id, start, end, title, subtitle, url, image, imageMIME.
- `ReplayGain` - `Gain`, `Peak` (both `float64`; `NaN` is "absent").
- `Credit` - `Role`, `Name` pair for TIPL / TMCL.
- `ITunesNormalisation` - LeftGain, RightGain, full `Raw [8]uint32`.
- `BroadcastWave` - bext + iXML + aXML + cart + UMID.
- `BroadcastExtension`, `CartChunk` - BWF sub-blocks.
- `Attachment`, `AttachmentSummary` - Matroska attachments.
- `OpenMGMetadata`, `OpenMGObject` - OMA / ATRAC metadata.
- `Tag` (interface) - read-only polymorphic view with `Kind() TagKind`,
  `Keys() []string`, `Get(name string) string`.
- `Container` (interface) - internal per-container save dispatch.
- `WritableSource` - `io.ReaderAt` + `io.WriterAt` + `Truncate(int64) error`.

## Constants

### `ContainerKind`

`ContainerMP3`, `ContainerWAV`, `ContainerAIFF`, `ContainerFLAC`, `ContainerMP4`,
`ContainerOGG`, `ContainerMAC`, `ContainerAAC`, `ContainerAC3`, `ContainerDTS`,
`ContainerAMR`, `ContainerWavPack`, `ContainerMPC`, `ContainerASF`,
`ContainerDSF`, `ContainerDFF`, `ContainerMatroska`, `ContainerTTA`,
`ContainerTAK`, `ContainerW64`, `ContainerMOD`, `ContainerS3M`, `ContainerXM`,
`ContainerIT`, `ContainerRealMedia`, `ContainerCAF`, `ContainerOMA`,
`ContainerUnknown`.

### `TagKind`

`TagID3v1`, `TagID3v2`, `TagVorbis`, `TagMP4`, `TagMatroska`, `TagTracker`,
`TagAPE`, `TagRIFFInfo`, `TagAIFFText`, `TagBWF`, `TagASF`, `TagRealMedia`,
`TagCAF`.

### `Format`

Bit flags: `FormatID3v1`, `FormatID3v22`, `FormatID3v23`, `FormatID3v24`.
`FormatID3v2Any` masks all v2 versions.

### `FieldKey`

`FieldTitle`, `FieldArtist`, `FieldAlbum`, `FieldAlbumArtist`, `FieldComposer`,
`FieldYear`, `FieldTrack`, `FieldDisc`, `FieldGenre`, `FieldComment`,
`FieldLyrics`, `FieldCompilation`, `FieldCopyright`, `FieldPublisher`,
`FieldEncodedBy`.

### `PictureType`

Matches the ID3 APIC type byte: `PictureOther`, `PictureFileIcon32x32`,
`PictureOtherFileIcon`, `PictureCoverFront`, `PictureCoverBack`,
`PictureLeafletPage`, `PictureMedia`, `PictureLeadArtist`, `PictureArtist`,
`PictureConductor`, `PictureBand`, `PictureComposer`, `PictureLyricist`,
`PictureRecordingLocation`, `PictureDuringRecording`,
`PictureDuringPerformance`, `PictureScreenCapture`,
`PictureBrightColouredFish`, `PictureIllustration`, `PictureBandLogo`,
`PicturePublisherLogo`.

### `MusicBrainzField`

`MusicBrainzRecordingID`, `MusicBrainzTrackID`, `MusicBrainzReleaseID`,
`MusicBrainzReleaseGroupID`, `MusicBrainzArtistID`,
`MusicBrainzAlbumArtistID` (alias: `MusicBrainzReleaseArtistID`),
`MusicBrainzWorkID`, `MusicBrainzReleaseType`.

### `GenreSyncStrategy`

`GenreSyncRawText` (exact match against the ID3v1 table),
`GenreSyncNearestCanonical` (case/whitespace-tolerant match, so "Hip Hop"
normalises to "Hip-Hop").

### Other

- `MaxMatroskaAttachmentsBytes` - 64 MiB cap on the attachments element.

## Subpackages

| Package | Contents |
|---|---|
| `github.com/tommyo123/mtag/id3v1` | `Tag` struct, `Read`, `Decode`, `Encode`, genre table helpers. |
| `github.com/tommyo123/mtag/id3v2` | `Tag`, `Frame` types (`TextFrame`, `CommentFrame`, `PictureFrame`, `URLFrame`, `UserTextFrame`, `PopularimeterFrame`, `PlayCountFrame`, `ChapterFrame`, `TOCFrame`, `RVA2Frame`, ...), `Read`, `Encode`, `EncodeString`, `DecodeString`, synchsafe helpers. |
| `github.com/tommyo123/mtag/flac` | `VorbisComment`, `Picture`, `Block`, `CueSheet`, `ReadBlocks`, `WriteBlock`, `DecodeVorbisComment`, `EncodeVorbisComment`. |
| `github.com/tommyo123/mtag/mp4` | `Item`, `MDTAItem`, `Chapter`, `ReadItems`, `EncodeILSTBody`, `ReadChapters`, `EncodeChplBody`, `RewriteMoovWithMetadata`, `WalkTopLevel`. |
| `github.com/tommyo123/mtag/ape` | `Tag`, `Field`, `FieldType`, `Read`, `Region`, standard field-name constants. |
