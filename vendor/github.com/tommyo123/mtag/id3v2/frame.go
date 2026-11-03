package id3v2

import (
	"bytes"
	"fmt"
	"math"
)

// FrameFlags holds the two flag bytes that appear in v2.3 and v2.4
// frame headers. v2.2 frames have no flag byte; we represent them
// with a zero-valued FrameFlags. The bit layout differs between 2.3
// and 2.4; the accessor methods below hide that difference.
type FrameFlags struct {
	// Raw is the two bytes exactly as they appear on disk.
	Raw [2]byte
	// Version is the major ID3v2 version the flags were read from
	// (3 or 4). It must be set whenever Raw is non-zero so the
	// accessors can interpret the bits correctly.
	Version byte
}

// v2.3 flag masks (ab c00000 ijk00000).
// v2.4 flag masks (0abc0000 0h00kmnp).

// TagAlterPreservation indicates the frame should be discarded when
// the containing tag is altered.
func (f FrameFlags) TagAlterPreservation() bool {
	switch f.Version {
	case 3:
		return f.Raw[0]&0x80 != 0
	case 4:
		return f.Raw[0]&0x40 != 0
	}
	return false
}

// FileAlterPreservation indicates the frame should be discarded when
// the audio data is altered.
func (f FrameFlags) FileAlterPreservation() bool {
	switch f.Version {
	case 3:
		return f.Raw[0]&0x40 != 0
	case 4:
		return f.Raw[0]&0x20 != 0
	}
	return false
}

// ReadOnly reports whether the frame is marked read-only.
func (f FrameFlags) ReadOnly() bool {
	switch f.Version {
	case 3:
		return f.Raw[0]&0x20 != 0
	case 4:
		return f.Raw[0]&0x10 != 0
	}
	return false
}

// Compressed reports whether the frame body is zlib-compressed.
func (f FrameFlags) Compressed() bool {
	switch f.Version {
	case 3:
		return f.Raw[1]&0x80 != 0
	case 4:
		return f.Raw[1]&0x08 != 0
	}
	return false
}

// Encrypted reports whether the frame body is encrypted.
func (f FrameFlags) Encrypted() bool {
	switch f.Version {
	case 3:
		return f.Raw[1]&0x40 != 0
	case 4:
		return f.Raw[1]&0x04 != 0
	}
	return false
}

// Grouped reports whether a grouping-identity byte precedes the frame
// payload.
func (f FrameFlags) Grouped() bool {
	switch f.Version {
	case 3:
		return f.Raw[1]&0x20 != 0
	case 4:
		return f.Raw[1]&0x40 != 0
	}
	return false
}

// Unsynchronised reports whether the frame body has per-frame
// unsynchronisation applied (v2.4 only).
func (f FrameFlags) Unsynchronised() bool {
	if f.Version == 4 {
		return f.Raw[1]&0x02 != 0
	}
	return false
}

// HasDataLengthIndicator reports whether a 4-byte synchsafe data
// length indicator precedes the frame body (v2.4 only).
func (f FrameFlags) HasDataLengthIndicator() bool {
	if f.Version == 4 {
		return f.Raw[1]&0x01 != 0
	}
	return false
}

// Frame is the common interface implemented by every ID3v2 frame
// type. Unknown frames are represented by RawFrame, and are
// round-tripped verbatim so that tags can be rewritten without data
// loss.
type Frame interface {
	// ID returns the canonical four-character frame ID (v2.3/2.4
	// form). Frames originating from v2.2 are upgraded on parse.
	ID() string
	// Body encodes the frame body for the supplied major version
	// (2, 3, or 4). The frame header is added by the Tag writer.
	Body(version byte) ([]byte, error)
	// Flags returns the per-frame flags (zero-valued for v2.2).
	Flags() FrameFlags
}

// RawFrame is used for frames mtag does not specially understand.
// Its body is preserved byte-for-byte so that rewrites do not lose
// information.
type RawFrame struct {
	FrameID    string
	Data       []byte
	FrameFlags FrameFlags
	// LegacyID keeps a three-letter v2.2 ID when no upgrade exists
	// (e.g. a third-party frame). It is empty for canonical frames.
	LegacyID string
}

func (r *RawFrame) ID() string        { return r.FrameID }
func (r *RawFrame) Flags() FrameFlags { return r.FrameFlags }
func (r *RawFrame) Body(byte) ([]byte, error) {
	b := make([]byte, len(r.Data))
	copy(b, r.Data)
	return b, nil
}

// EncryptedFrame is the read-side view of a frame whose body is
// encrypted. mtag does not decrypt the payload; it just strips the
// frame-header additions (method byte, optional group byte / length
// indicator) so callers can inspect the registration metadata while
// the encrypted bytes themselves still round-trip.
type EncryptedFrame struct {
	FrameID string
	// LegacyID keeps the original three-letter v2.2-style identifier
	// when this frame was upgraded on read. Encryption is a v2.3/2.4
	// feature, so this is almost always empty.
	LegacyID string

	MethodID byte
	// Registration is populated after the whole tag has been parsed,
	// by matching MethodID against any ENCR frame in the same tag.
	Registration *EncryptionRegistrationFrame

	GroupSymbol    byte
	HasGroupSymbol bool

	// DecompressedSize is the v2.3 extra field that precedes the
	// encrypted payload when the compression bit is also set.
	DecompressedSize    uint32
	HasDecompressedSize bool

	// DataLengthIndicator is the v2.4 extra field that may precede the
	// encrypted payload.
	DataLengthIndicator    uint32
	HasDataLengthIndicator bool

	Data       []byte
	FrameFlags FrameFlags
}

func (e *EncryptedFrame) ID() string        { return e.FrameID }
func (e *EncryptedFrame) Flags() FrameFlags { return e.FrameFlags }

func (e *EncryptedFrame) Body(version byte) ([]byte, error) {
	var out bytes.Buffer
	switch version {
	case 3:
		if e.FrameFlags.Compressed() {
			var sz [4]byte
			EncodeUint32BE(sz[:], e.DecompressedSize)
			out.Write(sz[:])
		}
		if e.FrameFlags.Encrypted() {
			out.WriteByte(e.MethodID)
		}
		if e.FrameFlags.Grouped() {
			out.WriteByte(e.GroupSymbol)
		}
	case 4:
		if e.FrameFlags.Grouped() {
			out.WriteByte(e.GroupSymbol)
		}
		if e.FrameFlags.Encrypted() {
			out.WriteByte(e.MethodID)
		}
		if e.FrameFlags.HasDataLengthIndicator() {
			var sz [4]byte
			if err := EncodeSynchsafe(sz[:], e.DataLengthIndicator); err != nil {
				return nil, err
			}
			out.Write(sz[:])
		}
	}
	out.Write(e.Data)
	body := out.Bytes()
	if version == 4 && e.FrameFlags.Unsynchronised() {
		body = Unsynchronise(body)
	}
	return body, nil
}

// TextFrame represents a T*** text-information frame. It carries one
// or more strings. ID3v2.2 and 2.3 only formally allow one string,
// but real-world files often contain NUL-separated multi-values, so
// we accept them on read and emit them on write. ID3v2.4 explicitly
// allows multiple values.
type TextFrame struct {
	FrameID    string
	Values     []string
	FrameFlags FrameFlags
}

func (t *TextFrame) ID() string        { return t.FrameID }
func (t *TextFrame) Flags() FrameFlags { return t.FrameFlags }

func (t *TextFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, t.Values...)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	for i, v := range t.Values {
		data, err := EncodeString(enc, v, false)
		if err != nil {
			return nil, err
		}
		buf.Write(data)
		if i < len(t.Values)-1 {
			switch enc {
			case EncISO8859, EncUTF8:
				buf.WriteByte(0)
			case EncUTF16, EncUTF16BE:
				buf.Write([]byte{0, 0})
			}
		}
	}
	return buf.Bytes(), nil
}

// UserTextFrame is the TXXX frame: a description plus a value.
type UserTextFrame struct {
	Description string
	Values      []string
	FrameFlags  FrameFlags
}

func (u *UserTextFrame) ID() string        { return FrameUserText }
func (u *UserTextFrame) Flags() FrameFlags { return u.FrameFlags }

func (u *UserTextFrame) Body(version byte) ([]byte, error) {
	all := append([]string{u.Description}, u.Values...)
	enc := PickEncoding(version, all...)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	desc, err := EncodeString(enc, u.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	for i, v := range u.Values {
		data, err := EncodeString(enc, v, false)
		if err != nil {
			return nil, err
		}
		buf.Write(data)
		if i < len(u.Values)-1 {
			switch enc {
			case EncISO8859, EncUTF8:
				buf.WriteByte(0)
			case EncUTF16, EncUTF16BE:
				buf.Write([]byte{0, 0})
			}
		}
	}
	return buf.Bytes(), nil
}

// URLFrame represents a W*** URL link frame. The URL is always
// encoded as ISO-8859-1 regardless of the tag's text encoding.
type URLFrame struct {
	FrameID    string
	URL        string
	FrameFlags FrameFlags
}

func (u *URLFrame) ID() string        { return u.FrameID }
func (u *URLFrame) Flags() FrameFlags { return u.FrameFlags }

func (u *URLFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(u.URL))
	for _, r := range u.URL {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	return out, nil
}

// UserURLFrame is WXXX: encoded description plus an ISO-8859-1 URL.
type UserURLFrame struct {
	Description string
	URL         string
	FrameFlags  FrameFlags
}

func (u *UserURLFrame) ID() string        { return FrameUserURL }
func (u *UserURLFrame) Flags() FrameFlags { return u.FrameFlags }

func (u *UserURLFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, u.Description)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	desc, err := EncodeString(enc, u.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	for _, r := range u.URL {
		if r > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(r))
		}
	}
	return buf.Bytes(), nil
}

// CommentFrame is a COMM frame (or a USLT frame, which has the same
// wire layout). Language is a three-letter ISO-639-2 code.
type CommentFrame struct {
	FrameID     string // "COMM" or "USLT"
	Language    string
	Description string
	Text        string
	FrameFlags  FrameFlags
}

func (c *CommentFrame) ID() string        { return c.FrameID }
func (c *CommentFrame) Flags() FrameFlags { return c.FrameFlags }

func (c *CommentFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, c.Description, c.Text)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	lang := c.Language
	if len(lang) < 3 {
		lang = (lang + "XXX")[:3]
	} else if len(lang) > 3 {
		lang = lang[:3]
	}
	buf.WriteString(lang)
	desc, err := EncodeString(enc, c.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	text, err := EncodeString(enc, c.Text, false)
	if err != nil {
		return nil, err
	}
	buf.Write(text)
	return buf.Bytes(), nil
}

// PictureFrame is an APIC frame (or a v2.2 PIC frame after upgrade).
type PictureFrame struct {
	MIME        string
	PictureType byte
	Description string
	Data        []byte
	FrameFlags  FrameFlags
}

func (p *PictureFrame) ID() string        { return FramePicture }
func (p *PictureFrame) Flags() FrameFlags { return p.FrameFlags }

func (p *PictureFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, p.Description)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	if version == 2 {
		// v2.2 PIC uses a 3-character image format, not MIME.
		fmtCode := mimeToImageFormat(p.MIME)
		buf.WriteString(fmtCode)
	} else {
		mime := p.MIME
		if mime == "" {
			mime = "image/jpeg"
		}
		buf.WriteString(mime)
		buf.WriteByte(0)
	}
	buf.WriteByte(p.PictureType)
	desc, err := EncodeString(enc, p.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	buf.Write(p.Data)
	return buf.Bytes(), nil
}

// PlayCountFrame is a PCNT frame. Its body is a variable-length
// big-endian unsigned integer (minimum four bytes per spec, grows
// as the counter overflows). mtag exposes the value as a uint64
// and re-emits the smallest big-endian encoding that fits the
// value (always at least four bytes per spec).
type PlayCountFrame struct {
	Count      uint64
	FrameFlags FrameFlags
}

func (p *PlayCountFrame) ID() string        { return FramePlayCount }
func (p *PlayCountFrame) Flags() FrameFlags { return p.FrameFlags }

func (p *PlayCountFrame) Body(byte) ([]byte, error) {
	out := encodeBigEndianCounter(p.Count, 4)
	return out, nil
}

// PopularimeterFrame is POPM: a rater email, a 0–255 rating byte,
// and an optional variable-length play counter that ties into the
// PCNT frame's value.
type PopularimeterFrame struct {
	Email      string
	Rating     byte // 0 unrated, 1–255 rating value (1=worst, 255=best)
	Count      uint64
	FrameFlags FrameFlags
}

func (p *PopularimeterFrame) ID() string        { return FramePopularimeter }
func (p *PopularimeterFrame) Flags() FrameFlags { return p.FrameFlags }

func (p *PopularimeterFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(p.Email)+1+1+4)
	for _, r := range p.Email {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0, p.Rating)
	if p.Count > 0 {
		out = append(out, encodeBigEndianCounter(p.Count, 0)...)
	}
	return out, nil
}

// encodeBigEndianCounter returns v as a big-endian unsigned integer
// using the smallest number of bytes that can hold it, but never
// fewer than min. Used by both PCNT and POPM whose counters share
// the same wire encoding.
func encodeBigEndianCounter(v uint64, min int) []byte {
	width := 1
	for tmp := v >> 8; tmp > 0; tmp >>= 8 {
		width++
	}
	if width < min {
		width = min
	}
	out := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		out[i] = byte(v)
		v >>= 8
	}
	return out
}

// decodeBigEndianCounter is the inverse, with a safety cap so a
// pathological tag can't load us with a thousand-byte counter.
func decodeBigEndianCounter(b []byte) uint64 {
	if len(b) > 8 {
		b = b[len(b)-8:] // keep low-order bytes
	}
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}

// ChapterFrame is a CHAP frame from the ID3v2 Chapter Frame
// Addendum. Each chapter has an opaque element identifier, time
// markers (in milliseconds), optional byte offsets into the audio
// stream, and a list of sub-frames (typically a TIT2 for the
// chapter title and optionally APIC, WXXX or other description
// frames).
//
// A byte offset value of 0xFFFFFFFF means "ignore me; use the
// time field instead".
type ChapterFrame struct {
	ElementID   string
	StartTimeMs uint32
	EndTimeMs   uint32
	StartOffset uint32 // 0xFFFFFFFF = unset
	EndOffset   uint32 // 0xFFFFFFFF = unset
	SubFrames   []Frame
	FrameFlags  FrameFlags
}

func (c *ChapterFrame) ID() string        { return FrameChapter }
func (c *ChapterFrame) Flags() FrameFlags { return c.FrameFlags }

func (c *ChapterFrame) Body(version byte) ([]byte, error) {
	var buf bytes.Buffer
	for _, r := range c.ElementID {
		if r > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(r))
		}
	}
	buf.WriteByte(0)
	var n [4]byte
	EncodeUint32BE(n[:], c.StartTimeMs)
	buf.Write(n[:])
	EncodeUint32BE(n[:], c.EndTimeMs)
	buf.Write(n[:])
	EncodeUint32BE(n[:], c.StartOffset)
	buf.Write(n[:])
	EncodeUint32BE(n[:], c.EndOffset)
	buf.Write(n[:])
	for _, sub := range c.SubFrames {
		if err := writeFrameHeader(&buf, version, sub.ID(), 0, sub.Flags()); err != nil {
			return nil, err
		}
		body, err := sub.Body(version)
		if err != nil {
			return nil, err
		}
		// writeFrameHeader took size=0 because we didn't know it
		// yet; rewrite the size field now.
		hdrLen := 10
		if version == 2 {
			hdrLen = 6
		}
		bs := buf.Bytes()
		hdrStart := len(bs) - hdrLen
		switch version {
		case 2:
			EncodeUint24BE(bs[hdrStart+3:hdrStart+6], uint32(len(body)))
		case 3:
			EncodeUint32BE(bs[hdrStart+4:hdrStart+8], uint32(len(body)))
		case 4:
			if err := EncodeSynchsafe(bs[hdrStart+4:hdrStart+8], uint32(len(body))); err != nil {
				return nil, err
			}
		}
		buf.Write(body)
	}
	return buf.Bytes(), nil
}

// TOCFrame is a CTOC frame: a list of child element IDs (which
// reference other CHAP/CTOC frames by their ElementID) plus
// optional sub-frames describing this level of the table.
type TOCFrame struct {
	ElementID  string
	TopLevel   bool
	Ordered    bool
	ChildIDs   []string
	SubFrames  []Frame
	FrameFlags FrameFlags
}

func (c *TOCFrame) ID() string        { return FrameTOC }
func (c *TOCFrame) Flags() FrameFlags { return c.FrameFlags }

func (c *TOCFrame) Body(version byte) ([]byte, error) {
	var buf bytes.Buffer
	for _, r := range c.ElementID {
		if r > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(r))
		}
	}
	buf.WriteByte(0)
	var flags byte
	if c.TopLevel {
		flags |= 0x02
	}
	if c.Ordered {
		flags |= 0x01
	}
	buf.WriteByte(flags)
	if len(c.ChildIDs) > 255 {
		return nil, fmt.Errorf("id3v2: CTOC entry count overflow (%d > 255)", len(c.ChildIDs))
	}
	buf.WriteByte(byte(len(c.ChildIDs)))
	for _, child := range c.ChildIDs {
		for _, r := range child {
			if r > 0xFF {
				buf.WriteByte('?')
			} else {
				buf.WriteByte(byte(r))
			}
		}
		buf.WriteByte(0)
	}
	for _, sub := range c.SubFrames {
		hdrLen := 10
		if version == 2 {
			hdrLen = 6
		}
		if err := writeFrameHeader(&buf, version, sub.ID(), 0, sub.Flags()); err != nil {
			return nil, err
		}
		body, err := sub.Body(version)
		if err != nil {
			return nil, err
		}
		bs := buf.Bytes()
		hdrStart := len(bs) - hdrLen
		switch version {
		case 2:
			EncodeUint24BE(bs[hdrStart+3:hdrStart+6], uint32(len(body)))
		case 3:
			EncodeUint32BE(bs[hdrStart+4:hdrStart+8], uint32(len(body)))
		case 4:
			if err := EncodeSynchsafe(bs[hdrStart+4:hdrStart+8], uint32(len(body))); err != nil {
				return nil, err
			}
		}
		buf.Write(body)
	}
	return buf.Bytes(), nil
}

// UniqueFileIDFrame is a UFID frame: an owner identifier (URL of
// the registry, e.g. "http://musicbrainz.org") plus an opaque
// identifier byte string. The struct field is named Identifier
// rather than ID so it doesn't shadow the [Frame.ID] method.
type UniqueFileIDFrame struct {
	Owner      string
	Identifier []byte
	FrameFlags FrameFlags
}

func (u *UniqueFileIDFrame) ID() string        { return FrameUFID }
func (u *UniqueFileIDFrame) Flags() FrameFlags { return u.FrameFlags }

func (u *UniqueFileIDFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(u.Owner)+1+len(u.Identifier))
	for _, r := range u.Owner {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0)
	out = append(out, u.Identifier...)
	return out, nil
}

// GeneralObjectFrame is GEOB: an arbitrary embedded payload tagged
// with a MIME type, a "filename" hint, and a free-form description.
// Often used for cue sheets, lyrics in proprietary formats, or
// player-specific bookkeeping.
type GeneralObjectFrame struct {
	MIME        string
	Filename    string
	Description string
	Data        []byte
	FrameFlags  FrameFlags
}

func (g *GeneralObjectFrame) ID() string        { return FrameGEOB }
func (g *GeneralObjectFrame) Flags() FrameFlags { return g.FrameFlags }

func (g *GeneralObjectFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, g.Filename, g.Description)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	for _, r := range g.MIME {
		if r > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(r))
		}
	}
	buf.WriteByte(0)
	fname, err := EncodeString(enc, g.Filename, true)
	if err != nil {
		return nil, err
	}
	buf.Write(fname)
	desc, err := EncodeString(enc, g.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	buf.Write(g.Data)
	return buf.Bytes(), nil
}

// SylTimestampFormat enumerates the unit used by the timestamps in
// a SYLT (and ETCO) frame.
type SylTimestampFormat byte

const (
	SylTimestampMPEGFrames SylTimestampFormat = 1 // 32-bit MPEG-frame indices
	SylTimestampMillis     SylTimestampFormat = 2 // milliseconds since file start
)

// SylContentType describes what the SYLT body actually carries.
// 1 = lyrics is the most common; the spec allows transcripts,
// movement names, chord changes, trivia, URLs and image refs.
type SylContentType byte

const (
	SylContentLyrics     SylContentType = 1
	SylContentTranscript SylContentType = 2
	SylContentMovement   SylContentType = 3
	SylContentEvents     SylContentType = 4
	SylContentChord      SylContentType = 5
	SylContentTrivia     SylContentType = 6
	SylContentURL        SylContentType = 7
	SylContentImage      SylContentType = 8
)

// SylEntry is one synchronised lyric line: a piece of text plus the
// time at which it should appear, in the units the parent
// [SyncedLyricsFrame] declares.
type SylEntry struct {
	Text      string
	Timestamp uint32
}

// SyncedLyricsFrame is a SYLT frame: time-stamped lyrics in the
// language indicated by Language. Many players use this for
// karaoke-style highlighting.
type SyncedLyricsFrame struct {
	Language    string // ISO-639-2 code, e.g. "eng"
	Format      SylTimestampFormat
	ContentType SylContentType
	Description string
	Entries     []SylEntry
	FrameFlags  FrameFlags
}

func (s *SyncedLyricsFrame) ID() string        { return FrameSYLT }
func (s *SyncedLyricsFrame) Flags() FrameFlags { return s.FrameFlags }

func (s *SyncedLyricsFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, s.Description)
	for _, e := range s.Entries {
		// Bump to whichever encoding accommodates every entry.
		if pe := PickEncoding(version, e.Text); pe > enc {
			enc = pe
		}
	}
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	lang := s.Language
	if len(lang) < 3 {
		lang = (lang + "XXX")[:3]
	} else if len(lang) > 3 {
		lang = lang[:3]
	}
	buf.WriteString(lang)
	buf.WriteByte(byte(s.Format))
	buf.WriteByte(byte(s.ContentType))
	desc, err := EncodeString(enc, s.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	for _, e := range s.Entries {
		text, err := EncodeString(enc, e.Text, true)
		if err != nil {
			return nil, err
		}
		buf.Write(text)
		var ts [4]byte
		EncodeUint32BE(ts[:], e.Timestamp)
		buf.Write(ts[:])
	}
	return buf.Bytes(), nil
}

// RVA2Channel identifies which audio channel a per-channel
// adjustment applies to. Values match the v2.4 spec.
type RVA2Channel byte

const (
	RVA2Other       RVA2Channel = 0
	RVA2MasterVol   RVA2Channel = 1
	RVA2FrontRight  RVA2Channel = 2
	RVA2FrontLeft   RVA2Channel = 3
	RVA2BackRight   RVA2Channel = 4
	RVA2BackLeft    RVA2Channel = 5
	RVA2FrontCenter RVA2Channel = 6
	RVA2BackCenter  RVA2Channel = 7
	RVA2Subwoofer   RVA2Channel = 8
)

// RVA2Adjustment is one per-channel volume entry inside an RVA2
// frame. Adjustment is stored as a 16-bit signed fixed-point value
// in 1/512 dB increments. Peak is the maximum sample magnitude
// expressed with PeakBits bits of precision.
type RVA2Adjustment struct {
	Channel    RVA2Channel
	Adjustment int16
	PeakBits   byte
	Peak       []byte // raw peak bytes, length = ceil(PeakBits/8)
}

// AdjustmentDB returns the channel volume change in decibels.
func (r RVA2Adjustment) AdjustmentDB() float64 {
	return float64(r.Adjustment) / 512.0
}

// PeakRatio returns the raw RVA2 peak value normalised to the [0, 1]
// range used by most ReplayGain software. This is necessarily lossy:
// RVA2 stores an arbitrary-width integer and the spec does not define
// any richer interpretation than "peak sample value".
func (r RVA2Adjustment) PeakRatio() (float64, bool) {
	if r.PeakBits == 0 || len(r.Peak) == 0 {
		return 0, false
	}
	var v uint64
	for _, b := range r.Peak {
		v = (v << 8) | uint64(b)
	}
	denom := math.Exp2(float64(r.PeakBits)) - 1
	if denom <= 0 {
		return 0, false
	}
	return float64(v) / denom, true
}

// RVA2Frame is the relative-volume frame from ID3v2.4. It carries
// one or more per-channel adjustment entries identified by an
// arbitrary identification string (so multiple normalisation
// algorithms can coexist in the same tag).
type RVA2Frame struct {
	Identification string
	Channels       []RVA2Adjustment
	FrameFlags     FrameFlags
}

func (r *RVA2Frame) ID() string        { return FrameRVA2 }
func (r *RVA2Frame) Flags() FrameFlags { return r.FrameFlags }

func (r *RVA2Frame) Body(byte) ([]byte, error) {
	var buf bytes.Buffer
	for _, c := range r.Identification {
		if c > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(c))
		}
	}
	buf.WriteByte(0)
	for _, ch := range r.Channels {
		buf.WriteByte(byte(ch.Channel))
		buf.WriteByte(byte(ch.Adjustment >> 8))
		buf.WriteByte(byte(ch.Adjustment))
		buf.WriteByte(ch.PeakBits)
		buf.Write(ch.Peak)
	}
	return buf.Bytes(), nil
}

// AudioTextFrame is the accessibility addendum's ATXT frame: a short
// audio clip plus the equivalent text string it speaks aloud.
type AudioTextFrame struct {
	MIME       string
	Scrambled  bool
	Text       string
	Audio      []byte
	FrameFlags FrameFlags
}

func (a *AudioTextFrame) ID() string        { return FrameATXT }
func (a *AudioTextFrame) Flags() FrameFlags { return a.FrameFlags }

func (a *AudioTextFrame) Body(version byte) ([]byte, error) {
	if version < 3 {
		return nil, fmt.Errorf("id3v2: ATXT requires ID3v2.3+")
	}
	enc := PickEncoding(version, a.Text)
	out := make([]byte, 0, 2+len(a.MIME)+len(a.Audio)+len(a.Text)*2)
	out = append(out, byte(enc))
	for _, r := range a.MIME {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0)
	if a.Scrambled {
		out = append(out, 1)
	} else {
		out = append(out, 0)
	}
	text, err := EncodeString(enc, a.Text, true)
	if err != nil {
		return nil, err
	}
	out = append(out, text...)
	out = append(out, a.Audio...)
	return out, nil
}

// LinkedInfoFrame is a LINK frame: references another ID3v2 tag
// by URL plus an optional frame identifier and ID data that select
// a specific frame inside the referenced tag.
type LinkedInfoFrame struct {
	FrameIdentifier string
	URL             string
	IDData          []byte
	FrameFlags      FrameFlags
}

func (l *LinkedInfoFrame) ID() string        { return FrameLINK }
func (l *LinkedInfoFrame) Flags() FrameFlags { return l.FrameFlags }

func (l *LinkedInfoFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, 4+len(l.URL)+1+len(l.IDData))
	fid := l.FrameIdentifier
	if len(fid) < 4 {
		fid = (fid + "    ")[:4]
	} else if len(fid) > 4 {
		fid = fid[:4]
	}
	out = append(out, fid...)
	for _, r := range l.URL {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0)
	out = append(out, l.IDData...)
	return out, nil
}

// CommercialFrame is a COMR frame: pricing and seller information
// for commercial releases.
type CommercialFrame struct {
	Prices       string
	ValidUntil   string // YYYYMMDD
	ContactURL   string
	ReceivedAs   byte
	NameOfSeller string
	Description  string
	PictureMIME  string
	Picture      []byte
	FrameFlags   FrameFlags
}

func (c *CommercialFrame) ID() string        { return FrameCOMR }
func (c *CommercialFrame) Flags() FrameFlags { return c.FrameFlags }

func (c *CommercialFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, c.NameOfSeller, c.Description)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	prices, err := EncodeString(EncISO8859, c.Prices, true)
	if err != nil {
		return nil, err
	}
	buf.Write(prices)
	date := c.ValidUntil
	if len(date) < 8 {
		date = (date + "00000000")[:8]
	} else if len(date) > 8 {
		date = date[:8]
	}
	buf.WriteString(date)
	url, err := EncodeString(EncISO8859, c.ContactURL, true)
	if err != nil {
		return nil, err
	}
	buf.Write(url)
	buf.WriteByte(c.ReceivedAs)
	seller, err := EncodeString(enc, c.NameOfSeller, true)
	if err != nil {
		return nil, err
	}
	buf.Write(seller)
	desc, err := EncodeString(enc, c.Description, true)
	if err != nil {
		return nil, err
	}
	buf.Write(desc)
	if len(c.Picture) > 0 {
		mime, err := EncodeString(EncISO8859, c.PictureMIME, true)
		if err != nil {
			return nil, err
		}
		buf.Write(mime)
		buf.Write(c.Picture)
	}
	return buf.Bytes(), nil
}

// RVADFrame is the ID3v2.3 predecessor of RVA2. mtag keeps the body
// verbatim — the wire format is a bitfield-driven set of
// variable-length fields that few players support and re-emitting
// them would need the original keys.
type RVADFrame struct {
	Data       []byte
	FrameFlags FrameFlags
}

func (r *RVADFrame) ID() string                { return FrameRVAD }
func (r *RVADFrame) Flags() FrameFlags         { return r.FrameFlags }
func (r *RVADFrame) Body(byte) ([]byte, error) { return append([]byte(nil), r.Data...), nil }

// EqualisationFrame covers EQUA (v2.3) and EQU2 (v2.4). Body is
// kept opaque because the two wire formats differ sharply, and
// faithful round-trip is what most callers need.
type EqualisationFrame struct {
	FrameID    string // "EQUA" or "EQU2"
	Data       []byte
	FrameFlags FrameFlags
}

func (e *EqualisationFrame) ID() string                { return e.FrameID }
func (e *EqualisationFrame) Flags() FrameFlags         { return e.FrameFlags }
func (e *EqualisationFrame) Body(byte) ([]byte, error) { return append([]byte(nil), e.Data...), nil }

// MLLTFrame is the MPEG location lookup table. Body-passthrough
// because a typed field list is large and rarely consulted.
type MLLTFrame struct {
	Data       []byte
	FrameFlags FrameFlags
}

func (m *MLLTFrame) ID() string                { return FrameMLLT }
func (m *MLLTFrame) Flags() FrameFlags         { return m.FrameFlags }
func (m *MLLTFrame) Body(byte) ([]byte, error) { return append([]byte(nil), m.Data...), nil }

// AudioEncryptionFrame is AENC: a DRM mechanism plus encrypted
// sample bytes. Kept opaque because we can't re-encrypt without
// the original key.
type AudioEncryptionFrame struct {
	Owner      string
	Data       []byte
	FrameFlags FrameFlags
}

func (a *AudioEncryptionFrame) ID() string        { return FrameAENC }
func (a *AudioEncryptionFrame) Flags() FrameFlags { return a.FrameFlags }

func (a *AudioEncryptionFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(a.Owner)+1+len(a.Data))
	for _, r := range a.Owner {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0)
	out = append(out, a.Data...)
	return out, nil
}

// EncryptionRegistrationFrame is ENCR: registers an encryption
// method within the tag.
type EncryptionRegistrationFrame struct {
	Owner      string
	MethodID   byte
	Data       []byte
	FrameFlags FrameFlags
}

func (e *EncryptionRegistrationFrame) ID() string        { return FrameENCR }
func (e *EncryptionRegistrationFrame) Flags() FrameFlags { return e.FrameFlags }

func (e *EncryptionRegistrationFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(e.Owner)+2+len(e.Data))
	for _, r := range e.Owner {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0, e.MethodID)
	out = append(out, e.Data...)
	return out, nil
}

// GroupRegistrationFrame is GRID: declares a grouping symbol used
// to tie frames together via the grouping-identity flag.
type GroupRegistrationFrame struct {
	Owner       string
	GroupSymbol byte
	GroupData   []byte
	FrameFlags  FrameFlags
}

func (g *GroupRegistrationFrame) ID() string        { return FrameGRID }
func (g *GroupRegistrationFrame) Flags() FrameFlags { return g.FrameFlags }

func (g *GroupRegistrationFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, len(g.Owner)+2+len(g.GroupData))
	for _, r := range g.Owner {
		if r > 0xFF {
			out = append(out, '?')
		} else {
			out = append(out, byte(r))
		}
	}
	out = append(out, 0, g.GroupSymbol)
	out = append(out, g.GroupData...)
	return out, nil
}

// PositionSyncFrame is POSS: the byte position or timestamp at
// which playback should (re)synchronise. Unit matches SYLT/ETCO.
type PositionSyncFrame struct {
	Format     SylTimestampFormat
	Position   uint32
	FrameFlags FrameFlags
}

func (p *PositionSyncFrame) ID() string        { return FramePOSS }
func (p *PositionSyncFrame) Flags() FrameFlags { return p.FrameFlags }

func (p *PositionSyncFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 5)
	out[0] = byte(p.Format)
	EncodeUint32BE(out[1:5], p.Position)
	return out, nil
}

// TermsOfUseFrame is a USER frame: a piece of legal text in a
// given language, using the standard text-encoding byte.
type TermsOfUseFrame struct {
	Language   string
	Text       string
	FrameFlags FrameFlags
}

func (u *TermsOfUseFrame) ID() string        { return FrameUSER }
func (u *TermsOfUseFrame) Flags() FrameFlags { return u.FrameFlags }

func (u *TermsOfUseFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, u.Text)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	lang := u.Language
	if len(lang) < 3 {
		lang = (lang + "XXX")[:3]
	} else if len(lang) > 3 {
		lang = lang[:3]
	}
	buf.WriteString(lang)
	text, err := EncodeString(enc, u.Text, false)
	if err != nil {
		return nil, err
	}
	buf.Write(text)
	return buf.Bytes(), nil
}

// OwnershipFrame is an OWNE frame: price + date of purchase +
// seller identifier.
type OwnershipFrame struct {
	Price      string // ISO 4217 currency code (3 chars) plus price
	DatePaid   string // 8-character YYYYMMDD
	Seller     string // free-form seller name
	FrameFlags FrameFlags
}

func (o *OwnershipFrame) ID() string        { return FrameOWNE }
func (o *OwnershipFrame) Flags() FrameFlags { return o.FrameFlags }

func (o *OwnershipFrame) Body(version byte) ([]byte, error) {
	enc := PickEncoding(version, o.Seller)
	var buf bytes.Buffer
	buf.WriteByte(byte(enc))
	price, err := EncodeString(EncISO8859, o.Price, true)
	if err != nil {
		return nil, err
	}
	buf.Write(price)
	date := o.DatePaid
	if len(date) < 8 {
		date = (date + "00000000")[:8]
	} else if len(date) > 8 {
		date = date[:8]
	}
	buf.WriteString(date)
	seller, err := EncodeString(enc, o.Seller, false)
	if err != nil {
		return nil, err
	}
	buf.Write(seller)
	return buf.Bytes(), nil
}

// BufferSizeFrame is an RBUF frame: recommended buffer size plus an
// optional embedded-info flag and offset.
type BufferSizeFrame struct {
	BufferSize   uint32 // 3-byte BE on the wire, we expose 4
	EmbeddedInfo bool
	OffsetToNext uint32 // 4-byte BE offset of next tag, 0 = unknown
	FrameFlags   FrameFlags
}

func (b *BufferSizeFrame) ID() string        { return FrameRBUF }
func (b *BufferSizeFrame) Flags() FrameFlags { return b.FrameFlags }

func (b *BufferSizeFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, 8)
	out = append(out,
		byte(b.BufferSize>>16), byte(b.BufferSize>>8), byte(b.BufferSize))
	flag := byte(0)
	if b.EmbeddedInfo {
		flag = 0x01
	}
	out = append(out, flag)
	var n [4]byte
	EncodeUint32BE(n[:], b.OffsetToNext)
	out = append(out, n[:]...)
	return out, nil
}

// ReverbFrame is an RVRB frame: detailed reverb parameters. Most of
// the fields are unused by modern playback software; we preserve
// them verbatim.
type ReverbFrame struct {
	LeftMs       uint16
	RightMs      uint16
	BouncesLeft  byte
	BouncesRight byte
	FeedbackLL   byte
	FeedbackLR   byte
	FeedbackRR   byte
	FeedbackRL   byte
	PremixLR     byte
	PremixRL     byte
	FrameFlags   FrameFlags
}

func (r *ReverbFrame) ID() string        { return FrameRVRB }
func (r *ReverbFrame) Flags() FrameFlags { return r.FrameFlags }

func (r *ReverbFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 12)
	out[0] = byte(r.LeftMs >> 8)
	out[1] = byte(r.LeftMs)
	out[2] = byte(r.RightMs >> 8)
	out[3] = byte(r.RightMs)
	out[4] = r.BouncesLeft
	out[5] = r.BouncesRight
	out[6] = r.FeedbackLL
	out[7] = r.FeedbackLR
	out[8] = r.FeedbackRR
	out[9] = r.FeedbackRL
	out[10] = r.PremixLR
	out[11] = r.PremixRL
	return out, nil
}

// EventEntry pairs an [EventType] with a timestamp in the units
// declared by the parent frame.
type EventEntry struct {
	Type      EventType
	Timestamp uint32
}

// EventType enumerates a handful of well-known markers from the
// ETCO frame; any byte value is legal and preserved verbatim.
type EventType byte

const (
	EventPadding           EventType = 0x00
	EventEndInitialSilence EventType = 0x01
	EventIntroStart        EventType = 0x02
	EventMainPartStart     EventType = 0x03
	EventOutroStart        EventType = 0x04
	EventVerseStart        EventType = 0x06
	EventRefrainStart      EventType = 0x07
	EventAudioEnd          EventType = 0xFD
	EventAudioFileEnd      EventType = 0xFE
)

// EventTimingCodesFrame is an ETCO frame: a sequence of
// (timestamp, event-type) pairs, where the timestamp unit is
// declared up-front (matches the SYLT encoding).
type EventTimingCodesFrame struct {
	Format     SylTimestampFormat
	Events     []EventEntry
	FrameFlags FrameFlags
}

func (e *EventTimingCodesFrame) ID() string        { return FrameETCO }
func (e *EventTimingCodesFrame) Flags() FrameFlags { return e.FrameFlags }

func (e *EventTimingCodesFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, 1+len(e.Events)*5)
	out = append(out, byte(e.Format))
	for _, ev := range e.Events {
		out = append(out, byte(ev.Type))
		var n [4]byte
		EncodeUint32BE(n[:], ev.Timestamp)
		out = append(out, n[:]...)
	}
	return out, nil
}

// TempoEntry is one beat-per-minute value from a SYTC frame.
// Tempo = 0 indicates a beat-less region; 1 is reserved; 2–510
// is the BPM; 511+ is encoded as an additional byte per the spec.
type TempoEntry struct {
	Tempo     int // parsed as uint8 / uint16, we widen for callers
	Timestamp uint32
}

// SyncedTempoCodesFrame is a SYTC frame: a sequence of
// (timestamp, tempo) pairs.
type SyncedTempoCodesFrame struct {
	Format     SylTimestampFormat
	Tempos     []TempoEntry
	FrameFlags FrameFlags
}

func (s *SyncedTempoCodesFrame) ID() string        { return FrameSYTC }
func (s *SyncedTempoCodesFrame) Flags() FrameFlags { return s.FrameFlags }

func (s *SyncedTempoCodesFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 0, 1+len(s.Tempos)*5)
	out = append(out, byte(s.Format))
	for _, t := range s.Tempos {
		if t.Tempo < 255 {
			out = append(out, byte(t.Tempo))
		} else {
			out = append(out, 0xFF, byte(t.Tempo-255))
		}
		var n [4]byte
		EncodeUint32BE(n[:], t.Timestamp)
		out = append(out, n[:]...)
	}
	return out, nil
}

// SeekFrame is a SEEK frame (v2.4): the byte offset of the next
// ID3v2 tag in the file, relative to the end of this tag.
type SeekFrame struct {
	Offset     uint32
	FrameFlags FrameFlags
}

func (s *SeekFrame) ID() string        { return FrameSEEK }
func (s *SeekFrame) Flags() FrameFlags { return s.FrameFlags }

func (s *SeekFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 4)
	EncodeUint32BE(out, s.Offset)
	return out, nil
}

// AudioSeekPointIndexFrame is an ASPI frame (v2.4): a lookup table
// from time to byte offset, used for fast seeking over variable
// bit-rate streams.
type AudioSeekPointIndexFrame struct {
	DataStart    uint32
	DataLength   uint32
	NumPoints    uint16
	BitsPerPoint byte
	// Points is kept as raw bytes because the element width (8 or
	// 16 bits per spec, but sometimes 32) depends on BitsPerPoint.
	Points     []byte
	FrameFlags FrameFlags
}

func (a *AudioSeekPointIndexFrame) ID() string        { return FrameASPI }
func (a *AudioSeekPointIndexFrame) Flags() FrameFlags { return a.FrameFlags }

func (a *AudioSeekPointIndexFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 11+len(a.Points))
	EncodeUint32BE(out[0:4], a.DataStart)
	EncodeUint32BE(out[4:8], a.DataLength)
	out[8] = byte(a.NumPoints >> 8)
	out[9] = byte(a.NumPoints)
	out[10] = a.BitsPerPoint
	copy(out[11:], a.Points)
	return out, nil
}

// SignatureFrame is a SIGN frame (v2.4): a group-symbol byte plus
// a signature payload. The signature algorithm is out of band.
type SignatureFrame struct {
	GroupSymbol byte
	Signature   []byte
	FrameFlags  FrameFlags
}

func (s *SignatureFrame) ID() string        { return FrameSIGN }
func (s *SignatureFrame) Flags() FrameFlags { return s.FrameFlags }

func (s *SignatureFrame) Body(byte) ([]byte, error) {
	out := make([]byte, 1+len(s.Signature))
	out[0] = s.GroupSymbol
	copy(out[1:], s.Signature)
	return out, nil
}

// MusicCDIDFrame is a MCDI frame: a binary CD table-of-contents
// blob (typically an Audio CD's TOC, used by online lookups against
// freedb / MusicBrainz / CDDB).
type MusicCDIDFrame struct {
	TOC        []byte
	FrameFlags FrameFlags
}

func (m *MusicCDIDFrame) ID() string                { return FrameMCDI }
func (m *MusicCDIDFrame) Flags() FrameFlags         { return m.FrameFlags }
func (m *MusicCDIDFrame) Body(byte) ([]byte, error) { return append([]byte(nil), m.TOC...), nil }

// PrivateFrame is a PRIV frame: an owner identifier plus binary data.
type PrivateFrame struct {
	Owner      string
	Data       []byte
	FrameFlags FrameFlags
}

func (p *PrivateFrame) ID() string        { return FramePrivate }
func (p *PrivateFrame) Flags() FrameFlags { return p.FrameFlags }

func (p *PrivateFrame) Body(byte) ([]byte, error) {
	var buf bytes.Buffer
	for _, r := range p.Owner {
		if r > 0xFF {
			buf.WriteByte('?')
		} else {
			buf.WriteByte(byte(r))
		}
	}
	buf.WriteByte(0)
	buf.Write(p.Data)
	return buf.Bytes(), nil
}

// parseFrameBody dispatches on frame ID and returns a typed frame
// instance. Unknown IDs return a RawFrame.
func parseFrameBody(id string, body []byte, flags FrameFlags) (Frame, error) {
	switch {
	case id == FrameUserText:
		return parseUserText(body, flags)
	case id == FrameUserURL:
		return parseUserURL(body, flags)
	case id == FrameComment || id == FrameLyrics:
		return parseComment(id, body, flags)
	case id == FramePicture:
		return parsePicture(body, flags)
	case id == FramePrivate:
		return parsePrivate(body, flags)
	case id == FramePlayCount:
		return parsePlayCount(body, flags)
	case id == FramePopularimeter:
		return parsePopularimeter(body, flags)
	case id == FrameChapter:
		return parseChapter(body, flags)
	case id == FrameTOC:
		return parseTOC(body, flags)
	case id == FrameUFID:
		return parseUFID(body, flags)
	case id == FrameGEOB:
		return parseGEOB(body, flags)
	case id == FrameMCDI:
		return &MusicCDIDFrame{TOC: append([]byte(nil), body...), FrameFlags: flags}, nil
	case id == FrameATXT:
		return parseATXT(body, flags)
	case id == FrameSYLT:
		return parseSYLT(body, flags)
	case id == FrameRVA2:
		return parseRVA2(body, flags)
	case id == FrameETCO:
		return parseETCO(body, flags)
	case id == FrameSYTC:
		return parseSYTC(body, flags)
	case id == FrameRVRB:
		return parseRVRB(body, flags)
	case id == FrameRBUF:
		return parseRBUF(body, flags)
	case id == FrameSEEK:
		return parseSEEK(body, flags)
	case id == FrameASPI:
		return parseASPI(body, flags)
	case id == FrameSIGN:
		return parseSIGN(body, flags)
	case id == FrameUSER:
		return parseUSER(body, flags)
	case id == FrameOWNE:
		return parseOWNE(body, flags)
	case id == FrameLINK:
		return parseLINK(body, flags)
	case id == FrameCOMR:
		return parseCOMR(body, flags)
	case id == FrameRVAD:
		return &RVADFrame{Data: append([]byte(nil), body...), FrameFlags: flags}, nil
	case id == FrameEQU2 || id == FrameEQUA:
		return &EqualisationFrame{FrameID: id, Data: append([]byte(nil), body...), FrameFlags: flags}, nil
	case id == FrameMLLT:
		return &MLLTFrame{Data: append([]byte(nil), body...), FrameFlags: flags}, nil
	case id == FrameAENC:
		return parseAENC(body, flags)
	case id == FrameENCR:
		return parseENCR(body, flags)
	case id == FrameGRID:
		return parseGRID(body, flags)
	case id == FramePOSS:
		return parsePOSS(body, flags)
	case IsTextFrame(id):
		return parseText(id, body, flags)
	case IsURLFrame(id):
		return parseURL(id, body, flags)
	}
	return &RawFrame{FrameID: id, Data: append([]byte(nil), body...), FrameFlags: flags}, nil
}

func parseText(id string, body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty text frame %s", id)
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	values, err := SplitStrings(enc, body[1:])
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		values = []string{""}
	}
	return &TextFrame{FrameID: id, Values: values, FrameFlags: flags}, nil
}

func parseUserText(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty TXXX frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	desc, off, err := SplitTerminated(enc, body[1:])
	if err != nil {
		return nil, err
	}
	rest := body[1+off:]
	values, err := SplitStrings(enc, rest)
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		values = []string{""}
	}
	return &UserTextFrame{Description: desc, Values: values, FrameFlags: flags}, nil
}

func parseURL(id string, body []byte, flags FrameFlags) (Frame, error) {
	// Drop one trailing NUL if present.
	if len(body) > 0 && body[len(body)-1] == 0 {
		body = body[:len(body)-1]
	}
	// URLs are specified as ISO-8859-1.
	out := make([]byte, 0, len(body)*2)
	for _, c := range body {
		if c > 0x7F {
			out = append(out, 0xC0|c>>6, 0x80|(c&0x3F))
		} else {
			out = append(out, c)
		}
	}
	return &URLFrame{FrameID: id, URL: string(out), FrameFlags: flags}, nil
}

func parseUserURL(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty WXXX frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	desc, off, err := SplitTerminated(enc, body[1:])
	if err != nil {
		return nil, err
	}
	rest := body[1+off:]
	if len(rest) > 0 && rest[len(rest)-1] == 0 {
		rest = rest[:len(rest)-1]
	}
	out := make([]byte, 0, len(rest)*2)
	for _, c := range rest {
		if c > 0x7F {
			out = append(out, 0xC0|c>>6, 0x80|(c&0x3F))
		} else {
			out = append(out, c)
		}
	}
	return &UserURLFrame{Description: desc, URL: string(out), FrameFlags: flags}, nil
}

func parseComment(id string, body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short %s frame", id)
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	lang := string(body[1:4])
	desc, off, err := SplitTerminated(enc, body[4:])
	if err != nil {
		return nil, err
	}
	text, err := DecodeString(enc, body[4+off:])
	if err != nil {
		return nil, err
	}
	return &CommentFrame{
		FrameID:     id,
		Language:    lang,
		Description: desc,
		Text:        text,
		FrameFlags:  flags,
	}, nil
}

func parsePicture(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 2 {
		return nil, fmt.Errorf("id3v2: short APIC frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	// MIME type is always ISO-8859-1, NUL-terminated.
	i := bytes.IndexByte(body[1:], 0)
	if i < 0 {
		return nil, fmt.Errorf("id3v2: APIC missing MIME terminator")
	}
	mime := string(body[1 : 1+i])
	rest := body[1+i+1:]
	if len(rest) < 1 {
		return nil, fmt.Errorf("id3v2: truncated APIC frame")
	}
	picType := rest[0]
	desc, off, err := SplitTerminated(enc, rest[1:])
	if err != nil {
		return nil, err
	}
	data := rest[1+off:]
	return &PictureFrame{
		MIME:        mime,
		PictureType: picType,
		Description: desc,
		Data:        append([]byte(nil), data...),
		FrameFlags:  flags,
	}, nil
}

// parsePictureV22 handles the legacy PIC frame whose image format is
// a three-character ISO-8859-1 code instead of a MIME string.
func parsePictureV22(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 5 {
		return nil, fmt.Errorf("id3v2: short PIC frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	fmtCode := string(body[1:4])
	picType := body[4]
	desc, off, err := SplitTerminated(enc, body[5:])
	if err != nil {
		return nil, err
	}
	data := body[5+off:]
	return &PictureFrame{
		MIME:        imageFormatToMIME(fmtCode),
		PictureType: picType,
		Description: desc,
		Data:        append([]byte(nil), data...),
		FrameFlags:  flags,
	}, nil
}

// parseSubFrames consumes a stream of standard frames (used inside
// CHAP and CTOC). The version is inherited from the enclosing tag.
func parseSubFrames(version byte, b []byte) []Frame {
	var out []Frame
	cur := 0
	for cur < len(b) {
		if b[cur] == 0 {
			break
		}
		f, n, err := readOneFrame(version, b[cur:])
		if err != nil || n <= 0 {
			break
		}
		if f != nil {
			out = append(out, f)
		}
		cur += n
	}
	return out
}

func parseChapter(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 || i+16 >= len(body) {
		return nil, fmt.Errorf("id3v2: short CHAP frame")
	}
	c := &ChapterFrame{
		ElementID:   string(body[:i]),
		StartTimeMs: DecodeUint32BE(body[i+1 : i+5]),
		EndTimeMs:   DecodeUint32BE(body[i+5 : i+9]),
		StartOffset: DecodeUint32BE(body[i+9 : i+13]),
		EndOffset:   DecodeUint32BE(body[i+13 : i+17]),
		FrameFlags:  flags,
	}
	v := flags.Version
	if v == 0 {
		v = 4
	}
	c.SubFrames = parseSubFrames(v, body[i+17:])
	return c, nil
}

func parseTOC(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 || i+2 >= len(body) {
		return nil, fmt.Errorf("id3v2: short CTOC frame")
	}
	flagsByte := body[i+1]
	count := int(body[i+2])
	cur := i + 3
	children := make([]string, 0, count)
	for k := 0; k < count && cur < len(body); k++ {
		end := bytes.IndexByte(body[cur:], 0)
		if end < 0 {
			break
		}
		children = append(children, string(body[cur:cur+end]))
		cur += end + 1
	}
	v := flags.Version
	if v == 0 {
		v = 4
	}
	return &TOCFrame{
		ElementID:  string(body[:i]),
		TopLevel:   flagsByte&0x02 != 0,
		Ordered:    flagsByte&0x01 != 0,
		ChildIDs:   children,
		SubFrames:  parseSubFrames(v, body[cur:]),
		FrameFlags: flags,
	}, nil
}

func parseSYLT(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 6 {
		return nil, fmt.Errorf("id3v2: short SYLT frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	out := &SyncedLyricsFrame{
		Language:    string(body[1:4]),
		Format:      SylTimestampFormat(body[4]),
		ContentType: SylContentType(body[5]),
		FrameFlags:  flags,
	}
	desc, off, err := SplitTerminated(enc, body[6:])
	if err != nil {
		return nil, err
	}
	out.Description = desc
	cur := 6 + off
	for cur < len(body) {
		text, n, err := SplitTerminated(enc, body[cur:])
		if err != nil {
			return nil, err
		}
		cur += n
		if cur+4 > len(body) {
			break
		}
		ts := DecodeUint32BE(body[cur : cur+4])
		cur += 4
		out.Entries = append(out.Entries, SylEntry{Text: text, Timestamp: ts})
	}
	return out, nil
}

func parseRVA2(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 {
		return nil, fmt.Errorf("id3v2: RVA2 missing identification terminator")
	}
	out := &RVA2Frame{
		Identification: string(body[:i]),
		FrameFlags:     flags,
	}
	cur := i + 1
	for cur < len(body) {
		if cur+4 > len(body) {
			break
		}
		ch := RVA2Adjustment{
			Channel:    RVA2Channel(body[cur]),
			Adjustment: int16(uint16(body[cur+1])<<8 | uint16(body[cur+2])),
			PeakBits:   body[cur+3],
		}
		cur += 4
		peakBytes := int((ch.PeakBits + 7) / 8)
		if cur+peakBytes > len(body) {
			break
		}
		ch.Peak = append([]byte(nil), body[cur:cur+peakBytes]...)
		cur += peakBytes
		out.Channels = append(out.Channels, ch)
	}
	return out, nil
}

func parseATXT(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 3 {
		return nil, fmt.Errorf("id3v2: short ATXT frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	i := bytes.IndexByte(body[1:], 0)
	if i < 0 {
		return nil, fmt.Errorf("id3v2: ATXT missing MIME terminator")
	}
	mimeEnd := 1 + i
	text, n, err := SplitTerminated(enc, body[mimeEnd+2:])
	if err != nil {
		return nil, err
	}
	audioAt := mimeEnd + 2 + n
	if audioAt > len(body) {
		audioAt = len(body)
	}
	return &AudioTextFrame{
		MIME:       string(body[1:mimeEnd]),
		Scrambled:  body[mimeEnd+1]&0x01 != 0,
		Text:       text,
		Audio:      append([]byte(nil), body[audioAt:]...),
		FrameFlags: flags,
	}, nil
}

func parseLINK(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short LINK frame")
	}
	out := &LinkedInfoFrame{
		FrameIdentifier: string(body[:4]),
		FrameFlags:      flags,
	}
	url, off, err := SplitTerminated(EncISO8859, body[4:])
	if err != nil {
		return nil, err
	}
	out.URL = url
	out.IDData = append([]byte(nil), body[4+off:]...)
	return out, nil
}

func parseCOMR(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: short COMR frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	cur := 1
	prices, off, err := SplitTerminated(EncISO8859, body[cur:])
	if err != nil {
		return nil, err
	}
	cur += off
	if cur+8 > len(body) {
		return nil, fmt.Errorf("id3v2: COMR missing date")
	}
	date := string(body[cur : cur+8])
	cur += 8
	url, off, err := SplitTerminated(EncISO8859, body[cur:])
	if err != nil {
		return nil, err
	}
	cur += off
	if cur >= len(body) {
		return nil, fmt.Errorf("id3v2: COMR missing received-as byte")
	}
	receivedAs := body[cur]
	cur++
	seller, off, err := SplitTerminated(enc, body[cur:])
	if err != nil {
		return nil, err
	}
	cur += off
	desc, off, err := SplitTerminated(enc, body[cur:])
	if err != nil {
		return nil, err
	}
	cur += off
	out := &CommercialFrame{
		Prices:       prices,
		ValidUntil:   date,
		ContactURL:   url,
		ReceivedAs:   receivedAs,
		NameOfSeller: seller,
		Description:  desc,
		FrameFlags:   flags,
	}
	if cur < len(body) {
		mime, off, err := SplitTerminated(EncISO8859, body[cur:])
		if err == nil {
			out.PictureMIME = mime
			out.Picture = append([]byte(nil), body[cur+off:]...)
		}
	}
	return out, nil
}

func parseAENC(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 {
		return nil, fmt.Errorf("id3v2: AENC missing owner terminator")
	}
	return &AudioEncryptionFrame{
		Owner:      string(body[:i]),
		Data:       append([]byte(nil), body[i+1:]...),
		FrameFlags: flags,
	}, nil
}

func parseENCR(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 || i+2 > len(body) {
		return nil, fmt.Errorf("id3v2: short ENCR frame")
	}
	return &EncryptionRegistrationFrame{
		Owner:      string(body[:i]),
		MethodID:   body[i+1],
		Data:       append([]byte(nil), body[i+2:]...),
		FrameFlags: flags,
	}, nil
}

func parseGRID(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 || i+2 > len(body) {
		return nil, fmt.Errorf("id3v2: short GRID frame")
	}
	return &GroupRegistrationFrame{
		Owner:       string(body[:i]),
		GroupSymbol: body[i+1],
		GroupData:   append([]byte(nil), body[i+2:]...),
		FrameFlags:  flags,
	}, nil
}

func parsePOSS(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 5 {
		return nil, fmt.Errorf("id3v2: short POSS frame")
	}
	return &PositionSyncFrame{
		Format:     SylTimestampFormat(body[0]),
		Position:   DecodeUint32BE(body[1:5]),
		FrameFlags: flags,
	}, nil
}

func parseETCO(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty ETCO frame")
	}
	out := &EventTimingCodesFrame{Format: SylTimestampFormat(body[0]), FrameFlags: flags}
	for cur := 1; cur+5 <= len(body); cur += 5 {
		out.Events = append(out.Events, EventEntry{
			Type:      EventType(body[cur]),
			Timestamp: DecodeUint32BE(body[cur+1 : cur+5]),
		})
	}
	return out, nil
}

func parseSYTC(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty SYTC frame")
	}
	out := &SyncedTempoCodesFrame{Format: SylTimestampFormat(body[0]), FrameFlags: flags}
	cur := 1
	for cur < len(body) {
		if cur >= len(body) {
			break
		}
		tempo := int(body[cur])
		cur++
		if tempo == 255 && cur < len(body) {
			tempo += int(body[cur])
			cur++
		}
		if cur+4 > len(body) {
			break
		}
		out.Tempos = append(out.Tempos, TempoEntry{
			Tempo:     tempo,
			Timestamp: DecodeUint32BE(body[cur : cur+4]),
		})
		cur += 4
	}
	return out, nil
}

func parseRVRB(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 12 {
		return nil, fmt.Errorf("id3v2: short RVRB frame")
	}
	return &ReverbFrame{
		LeftMs:       uint16(body[0])<<8 | uint16(body[1]),
		RightMs:      uint16(body[2])<<8 | uint16(body[3]),
		BouncesLeft:  body[4],
		BouncesRight: body[5],
		FeedbackLL:   body[6],
		FeedbackLR:   body[7],
		FeedbackRR:   body[8],
		FeedbackRL:   body[9],
		PremixLR:     body[10],
		PremixRL:     body[11],
		FrameFlags:   flags,
	}, nil
}

func parseRBUF(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short RBUF frame")
	}
	out := &BufferSizeFrame{
		BufferSize:   uint32(body[0])<<16 | uint32(body[1])<<8 | uint32(body[2]),
		EmbeddedInfo: body[3]&0x01 != 0,
		FrameFlags:   flags,
	}
	if len(body) >= 8 {
		out.OffsetToNext = DecodeUint32BE(body[4:8])
	}
	return out, nil
}

func parseSEEK(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short SEEK frame")
	}
	return &SeekFrame{Offset: DecodeUint32BE(body[:4]), FrameFlags: flags}, nil
}

func parseASPI(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 11 {
		return nil, fmt.Errorf("id3v2: short ASPI frame")
	}
	return &AudioSeekPointIndexFrame{
		DataStart:    DecodeUint32BE(body[0:4]),
		DataLength:   DecodeUint32BE(body[4:8]),
		NumPoints:    uint16(body[8])<<8 | uint16(body[9]),
		BitsPerPoint: body[10],
		Points:       append([]byte(nil), body[11:]...),
		FrameFlags:   flags,
	}, nil
}

func parseSIGN(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty SIGN frame")
	}
	return &SignatureFrame{
		GroupSymbol: body[0],
		Signature:   append([]byte(nil), body[1:]...),
		FrameFlags:  flags,
	}, nil
}

func parseUSER(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short USER frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	text, err := DecodeString(enc, body[4:])
	if err != nil {
		return nil, err
	}
	return &TermsOfUseFrame{
		Language:   string(body[1:4]),
		Text:       text,
		FrameFlags: flags,
	}, nil
}

func parseOWNE(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: short OWNE frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	price, off, err := SplitTerminated(EncISO8859, body[1:])
	if err != nil {
		return nil, err
	}
	cur := 1 + off
	if cur+8 > len(body) {
		return nil, fmt.Errorf("id3v2: OWNE missing date field")
	}
	date := string(body[cur : cur+8])
	cur += 8
	seller, err := DecodeString(enc, body[cur:])
	if err != nil {
		return nil, err
	}
	return &OwnershipFrame{
		Price:      price,
		DatePaid:   date,
		Seller:     seller,
		FrameFlags: flags,
	}, nil
}

func parseUFID(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 {
		return nil, fmt.Errorf("id3v2: UFID missing owner terminator")
	}
	return &UniqueFileIDFrame{
		Owner:      string(body[:i]),
		Identifier: append([]byte(nil), body[i+1:]...),
		FrameFlags: flags,
	}, nil
}

func parseGEOB(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("id3v2: short GEOB frame")
	}
	enc := Encoding(body[0])
	if !enc.Valid() {
		return nil, ErrInvalidEncoding
	}
	rest := body[1:]
	mimeEnd := bytes.IndexByte(rest, 0)
	if mimeEnd < 0 {
		return nil, fmt.Errorf("id3v2: GEOB missing MIME terminator")
	}
	mime := string(rest[:mimeEnd])
	rest = rest[mimeEnd+1:]
	fname, off, err := SplitTerminated(enc, rest)
	if err != nil {
		return nil, err
	}
	rest = rest[off:]
	desc, off, err := SplitTerminated(enc, rest)
	if err != nil {
		return nil, err
	}
	rest = rest[off:]
	return &GeneralObjectFrame{
		MIME:        mime,
		Filename:    fname,
		Description: desc,
		Data:        append([]byte(nil), rest...),
		FrameFlags:  flags,
	}, nil
}

func parsePlayCount(body []byte, flags FrameFlags) (Frame, error) {
	if len(body) < 1 {
		return nil, fmt.Errorf("id3v2: empty PCNT frame")
	}
	return &PlayCountFrame{Count: decodeBigEndianCounter(body), FrameFlags: flags}, nil
}

func parsePopularimeter(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 || i+1 >= len(body) {
		return nil, fmt.Errorf("id3v2: malformed POPM frame")
	}
	email := string(body[:i])
	rating := body[i+1]
	var count uint64
	if i+2 < len(body) {
		count = decodeBigEndianCounter(body[i+2:])
	}
	return &PopularimeterFrame{
		Email:      email,
		Rating:     rating,
		Count:      count,
		FrameFlags: flags,
	}, nil
}

func parsePrivate(body []byte, flags FrameFlags) (Frame, error) {
	i := bytes.IndexByte(body, 0)
	if i < 0 {
		return &PrivateFrame{Owner: string(body), FrameFlags: flags}, nil
	}
	return &PrivateFrame{
		Owner:      string(body[:i]),
		Data:       append([]byte(nil), body[i+1:]...),
		FrameFlags: flags,
	}, nil
}

// imageFormatToMIME upgrades a v2.2 PIC format code to the nearest
// modern MIME type.
func imageFormatToMIME(code string) string {
	switch code {
	case "JPG", "JPEG":
		return "image/jpeg"
	case "PNG":
		return "image/png"
	case "GIF":
		return "image/gif"
	case "BMP":
		return "image/bmp"
	}
	return "application/octet-stream"
}

// mimeToImageFormat picks the matching 3-letter PIC code. Defaults
// to "JPG" if the MIME isn't one of the common ones, since every
// v2.2 implementation recognises it.
func mimeToImageFormat(mime string) string {
	switch mime {
	case "image/jpeg", "image/jpg":
		return "JPG"
	case "image/png":
		return "PNG"
	case "image/gif":
		return "GIF"
	case "image/bmp":
		return "BMP"
	}
	return "JPG"
}
