// Package mtag provides read and write access to audio metadata across
// multiple container formats.
//
// The top-level [File] API covers common fields such as title, artist,
// album, track, disc, year, genre, comments, lyrics, images,
// ReplayGain, MusicBrainz IDs, chapters, podcast fields, and custom
// values. [File.AudioProperties] reports codec, duration, bitrate,
// sample rate, channel count, and related stream properties.
//
// Native stores remain available through accessors such as [File.ID3v1],
// [File.ID3v2], [File.APEv2], [File.Tags], and [File.Tag].
//
// Open a file with [Open], [OpenSource], [OpenWritableSource], or
// [OpenBytes], inspect or mutate fields on [File], then persist the
// result with [File.Save], [File.SaveContext], or [File.SaveFormats].
//
// [File.Save] preserves the tag families already present on disk.
// [File.SaveFormats] is the exact-format API for callers that need to
// choose the on-disk ID3 layout explicitly.
//
// Most setters do not return an error directly. When a value cannot be
// represented in the current writable store, the setter records a
// recoverable error that can be inspected through [File.Err] or
// [File.Errs]. Immediate failures, such as I/O errors or Save on a
// read-only file, are returned from [File.Save] and [File.SaveContext].
//
// A [File] is not safe for concurrent use.
package mtag
