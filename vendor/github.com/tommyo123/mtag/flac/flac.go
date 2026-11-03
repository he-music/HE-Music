// Package flac reads metadata blocks from a FLAC stream.
//
// The on-disk format is described in https://xiph.org/flac/format.html.
// A FLAC file starts with the "fLaC" magic, followed by one or more
// metadata blocks (1-bit "is last", 7-bit type, 24-bit length). Audio
// frames begin immediately after the last metadata block.
//
// Only VORBIS_COMMENT (type 4) and PICTURE (type 6) are decoded; the
// remaining block types are preserved as opaque [RawBlock] values so
// the walker can round-trip them without mutation.
package flac

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MagicSize is the length of the "fLaC" magic prefix.
const MagicSize = 4

// Magic is the four-byte signature at the start of every FLAC file.
var Magic = [4]byte{'f', 'L', 'a', 'C'}

// BlockType identifies a FLAC metadata block.
type BlockType uint8

const (
	BlockStreamInfo    BlockType = 0
	BlockPadding       BlockType = 1
	BlockApplication   BlockType = 2
	BlockSeekTable     BlockType = 3
	BlockVorbisComment BlockType = 4
	BlockCueSheet      BlockType = 5
	BlockPicture       BlockType = 6
)

// ErrNotFLAC is returned when the magic prefix is wrong.
var ErrNotFLAC = errors.New("flac: not a FLAC stream")

// Block is the decoded metadata-block envelope. Body holds the raw
// bytes of the block; specific decoders ([DecodeVorbisComment],
// [DecodePicture]) interpret it.
type Block struct {
	Type   BlockType
	IsLast bool
	Body   []byte
}

// ReadBlocks walks every metadata block in r starting at offset
// MagicSize. The audio frames that follow the last block are not
// touched. The total number of bytes consumed (relative to the start
// of the file) is also returned so callers can locate the audio
// region for a future write path.
func ReadBlocks(r io.ReaderAt, size int64) ([]Block, int64, error) {
	return ReadBlocksWithOptions(r, size, false)
}

// ReadBlocksWithOptions is [ReadBlocks] with selective skipping for
// metadata bodies the caller does not need.
func ReadBlocksWithOptions(r io.ReaderAt, size int64, skipPictures bool) ([]Block, int64, error) {
	if size < int64(MagicSize) {
		return nil, 0, ErrNotFLAC
	}
	var magic [4]byte
	if _, err := r.ReadAt(magic[:], 0); err != nil {
		return nil, 0, err
	}
	if magic != Magic {
		return nil, 0, ErrNotFLAC
	}

	var blocks []Block
	cur := int64(MagicSize)
	for cur+4 <= size {
		var hdr [4]byte
		if _, err := r.ReadAt(hdr[:], cur); err != nil {
			return nil, cur, err
		}
		isLast := hdr[0]&0x80 != 0
		bt := BlockType(hdr[0] & 0x7F)
		length := int64(uint32(hdr[1])<<16 | uint32(hdr[2])<<8 | uint32(hdr[3]))
		dataStart := cur + 4
		if length < 0 || dataStart+length > size {
			return blocks, cur, fmt.Errorf("flac: block %d declares oversize length %d", bt, length)
		}
		if skipPictures && bt == BlockPicture {
			cur = dataStart + length
			if isLast {
				break
			}
			continue
		}
		body := make([]byte, length)
		if length > 0 {
			if _, err := r.ReadAt(body, dataStart); err != nil {
				return blocks, cur, err
			}
		}
		blocks = append(blocks, Block{Type: bt, IsLast: isLast, Body: body})
		cur = dataStart + length
		if isLast {
			break
		}
	}
	return blocks, cur, nil
}

// WriteBlock serialises one metadata block (header + body) onto w.
// The 24-bit length field caps a single block at 16 MiB; longer
// payloads return an error rather than silently truncating.
func WriteBlock(w io.Writer, b Block) error {
	if len(b.Body) >= 1<<24 {
		return fmt.Errorf("flac: block %d body %d bytes exceeds 24-bit length", b.Type, len(b.Body))
	}
	var hdr [4]byte
	hdr[0] = byte(b.Type) & 0x7F
	if b.IsLast {
		hdr[0] |= 0x80
	}
	length := uint32(len(b.Body))
	hdr[1] = byte(length >> 16)
	hdr[2] = byte(length >> 8)
	hdr[3] = byte(length)
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(b.Body) > 0 {
		if _, err := w.Write(b.Body); err != nil {
			return err
		}
	}
	return nil
}

// VorbisComment is the parsed payload of a [BlockVorbisComment]
// block. Field names are case-insensitive per spec.
type VorbisComment struct {
	Vendor string
	// Fields is an ordered list so multi-valued tags (multiple
	// ARTIST entries, for instance) round-trip exactly.
	Fields []Field
}

// Field is one "NAME=VALUE" entry from a Vorbis Comment block.
type Field struct {
	Name  string // canonical form: uppercase
	Value string // already UTF-8
}

// Get returns the first value with the given name, or "".
func (v *VorbisComment) Get(name string) string {
	all := v.GetAll(name)
	if len(all) == 0 {
		return ""
	}
	return all[0]
}

// GetAll returns every value matching name (case-insensitive).
func (v *VorbisComment) GetAll(name string) []string {
	var out []string
	for _, f := range v.Fields {
		if equalFold(f.Name, name) {
			out = append(out, f.Value)
		}
	}
	return out
}

// Set replaces every entry matching name with a single new value.
// Pass an empty string to delete.
func (v *VorbisComment) Set(name, value string) {
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !equalFold(f.Name, name) {
			kept = append(kept, f)
		}
	}
	v.Fields = kept
	if value == "" {
		return
	}
	v.Fields = append(v.Fields, Field{Name: upper(name), Value: value})
}

// DecodeVorbisComment parses a [BlockVorbisComment] body.
func DecodeVorbisComment(body []byte) (*VorbisComment, error) {
	return DecodeVorbisCommentWithOptions(body, false)
}

// DecodeVorbisCommentWithOptions parses a [BlockVorbisComment] body
// and can skip picture-bearing fields to avoid materialising large
// base64 payloads the caller will discard anyway.
func DecodeVorbisCommentWithOptions(body []byte, skipPictures bool) (*VorbisComment, error) {
	if len(body) < 4 {
		return nil, fmt.Errorf("flac: short Vorbis comment block")
	}
	cur := 0
	vendorLen := int(binary.LittleEndian.Uint32(body[cur:]))
	cur += 4
	if vendorLen < 0 || cur+vendorLen > len(body) {
		return nil, fmt.Errorf("flac: vendor length out of range")
	}
	vendor := string(body[cur : cur+vendorLen])
	cur += vendorLen

	if cur+4 > len(body) {
		return nil, fmt.Errorf("flac: missing comment count")
	}
	count := int(binary.LittleEndian.Uint32(body[cur:]))
	cur += 4
	// Each comment needs at least a 4-byte length prefix, so a count
	// that would require more bytes than remain is garbage. Bound the
	// slice capacity to avoid a multi-GiB allocation from a malformed
	// header.
	if count < 0 || count > (len(body)-cur)/4 {
		return nil, fmt.Errorf("flac: comment count %d exceeds body size", count)
	}
	out := &VorbisComment{Vendor: vendor, Fields: make([]Field, 0, count)}
	for i := 0; i < count; i++ {
		if cur+4 > len(body) {
			return out, fmt.Errorf("flac: truncated comment %d", i)
		}
		l := int(binary.LittleEndian.Uint32(body[cur:]))
		cur += 4
		if l < 0 || cur+l > len(body) {
			return out, fmt.Errorf("flac: comment %d length out of range", i)
		}
		raw := string(body[cur : cur+l])
		cur += l
		eq := indexByte(raw, '=')
		if eq < 0 {
			out.Fields = append(out.Fields, Field{Name: upper(raw)})
			continue
		}
		name := upper(raw[:eq])
		if skipPictures && (name == "METADATA_BLOCK_PICTURE" || name == "COVERART") {
			continue
		}
		out.Fields = append(out.Fields, Field{Name: name, Value: raw[eq+1:]})
	}
	return out, nil
}

// EncodeVorbisComment serialises v into the body bytes of a
// VORBIS_COMMENT metadata block, ready for embedding inside a Block
// envelope.
func EncodeVorbisComment(v *VorbisComment) []byte {
	out := make([]byte, 0, 16+len(v.Vendor)+len(v.Fields)*32)
	var u32 [4]byte
	binary.LittleEndian.PutUint32(u32[:], uint32(len(v.Vendor)))
	out = append(out, u32[:]...)
	out = append(out, v.Vendor...)
	binary.LittleEndian.PutUint32(u32[:], uint32(len(v.Fields)))
	out = append(out, u32[:]...)
	for _, f := range v.Fields {
		entry := f.Name + "=" + f.Value
		binary.LittleEndian.PutUint32(u32[:], uint32(len(entry)))
		out = append(out, u32[:]...)
		out = append(out, entry...)
	}
	return out
}

// Picture is the parsed payload of a [BlockPicture] block.
type Picture struct {
	Type        uint32 // matches the ID3v2 APIC picture-type values
	MIME        string
	Description string
	Width       uint32
	Height      uint32
	Depth       uint32
	NumColors   uint32
	Data        []byte
}

// DecodePicture parses a [BlockPicture] body.
func DecodePicture(body []byte) (*Picture, error) {
	if len(body) < 32 {
		return nil, fmt.Errorf("flac: short PICTURE block")
	}
	cur := 0
	read32 := func() uint32 {
		v := binary.BigEndian.Uint32(body[cur:])
		cur += 4
		return v
	}
	readBytes := func(n int) ([]byte, error) {
		if n < 0 || cur+n > len(body) {
			return nil, fmt.Errorf("flac: PICTURE field overruns block")
		}
		b := body[cur : cur+n]
		cur += n
		return b, nil
	}

	pic := &Picture{Type: read32()}
	mimeLen := int(read32())
	mime, err := readBytes(mimeLen)
	if err != nil {
		return nil, err
	}
	pic.MIME = string(mime)
	descLen := int(read32())
	desc, err := readBytes(descLen)
	if err != nil {
		return nil, err
	}
	pic.Description = string(desc)
	pic.Width = read32()
	pic.Height = read32()
	pic.Depth = read32()
	pic.NumColors = read32()
	dataLen := int(read32())
	data, err := readBytes(dataLen)
	if err != nil {
		return nil, err
	}
	pic.Data = append([]byte(nil), data...)
	return pic, nil
}

// EncodePicture serialises p into a PICTURE block body.
func EncodePicture(p *Picture) []byte {
	out := make([]byte, 0, 32+len(p.MIME)+len(p.Description)+len(p.Data))
	put32 := func(v uint32) {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], v)
		out = append(out, b[:]...)
	}
	put32(p.Type)
	put32(uint32(len(p.MIME)))
	out = append(out, p.MIME...)
	put32(uint32(len(p.Description)))
	out = append(out, p.Description...)
	put32(p.Width)
	put32(p.Height)
	put32(p.Depth)
	put32(p.NumColors)
	put32(uint32(len(p.Data)))
	out = append(out, p.Data...)
	return out
}

// upper uppercases an ASCII string. Vorbis Comment names are
// recommended to be uppercased on disk; mtag canonicalises them so
// case-insensitive lookups are O(n) instead of O(n) plus a fold.
func upper(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'a' && ca <= 'z' {
			ca -= 'a' - 'A'
		}
		if cb >= 'a' && cb <= 'z' {
			cb -= 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
