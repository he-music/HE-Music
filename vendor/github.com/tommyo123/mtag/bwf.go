package mtag

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// BroadcastExtension is the typed view of a WAV/BWF "bext" chunk.
// Strings are ASCII per the spec; trailing NULs and padding spaces
// are trimmed on read.
type BroadcastExtension struct {
	Description          string
	Originator           string
	OriginatorReference  string
	OriginationDate      string
	OriginationTime      string
	TimeReference        uint64
	Version              uint16
	UMID                 []byte
	LoudnessValue        int16
	LoudnessRange        int16
	MaxTruePeakLevel     int16
	MaxMomentaryLoudness int16
	MaxShortTermLoudness int16
	CodingHistory        string
}

// UMIDHex returns the extension UMID as `0x...`, or "" when the bext
// block carried no UMID.
func (b *BroadcastExtension) UMIDHex() string {
	if b == nil {
		return ""
	}
	return formatUMIDHex(b.UMID)
}

// CartChunk is the raw view of a WAV "cart" chunk.
type CartChunk struct {
	Raw []byte
}

// BroadcastWave holds broadcast-specific RIFF/WAV metadata.
type BroadcastWave struct {
	Extension *BroadcastExtension
	IXML      string
	AXML      string
	Cart      *CartChunk
	UMID      []byte // standalone "umid" chunk, when present
}

// UMIDHex returns the standalone UMID as `0x...`, or "" when no such
// chunk exists.
func (b *BroadcastWave) UMIDHex() string {
	if b == nil {
		return ""
	}
	return formatUMIDHex(b.UMID)
}

type bwfView struct {
	ext  *BroadcastExtension
	ixml string
	axml string
	cart *CartChunk
	umid []byte
	// dirty flips to true whenever a caller mutates the view via
	// one of the typed setters. The save path uses it to skip the
	// byte-for-byte passthrough and emit freshly encoded chunks
	// from the in-memory view.
	dirty bool
}

func (v *bwfView) empty() bool {
	return v == nil || (v.ext == nil && v.ixml == "" && v.axml == "" && v.cart == nil && len(v.umid) == 0)
}

// BroadcastWave returns the typed broadcast-metadata view for WAV/BWF
// files. It includes the BWF "bext" block plus any iXML / axml /
// cart / standalone umid chunks found at top level.
func (f *File) BroadcastWave() (*BroadcastWave, bool) {
	if f.bwf == nil || f.bwf.empty() {
		return nil, false
	}
	out := &BroadcastWave{
		IXML: f.bwf.ixml,
		AXML: f.bwf.axml,
		UMID: append([]byte(nil), f.bwf.umid...),
	}
	if f.bwf.ext != nil {
		cp := *f.bwf.ext
		cp.UMID = append([]byte(nil), cp.UMID...)
		out.Extension = &cp
	}
	if f.bwf.cart != nil {
		out.Cart = &CartChunk{Raw: append([]byte(nil), f.bwf.cart.Raw...)}
	}
	return out, true
}

const (
	riffBEXT = "bext"
	riffIXML = "iXML"
	riffAXML = "axml"
	riffCART = "cart"
	riffUMID = "umid"
)

func scanForwardForWAVBWFChunk(r io.ReaderAt, from, size int64) (chunkSpan, bool) {
	return scanForwardForIFFChunk(r, from, size, binary.LittleEndian, func(id [4]byte) bool {
		switch string(id[:]) {
		case riffBEXT, riffIXML, riffAXML, riffCART, riffUMID:
			return true
		}
		return false
	})
}

func scanWAVBWF(r io.ReaderAt, size int64) *bwfView {
	if outer := readIFFOuterMagic(r); isRF64Magic(outer) {
		out := &bwfView{}
		for _, c := range listIFFChunks(r, size, binary.LittleEndian, outer) {
			chunkID := string(c.ID[:])
			switch chunkID {
			case riffBEXT, riffIXML, riffAXML, riffCART, riffUMID:
			default:
				continue
			}
			body := make([]byte, c.DataSize)
			if _, err := r.ReadAt(body, c.DataAt); err != nil {
				continue
			}
			switch chunkID {
			case riffBEXT:
				out.ext = parseBEXT(body)
			case riffIXML:
				out.ixml = trimXMLChunk(body)
			case riffAXML:
				out.axml = trimXMLChunk(body)
			case riffCART:
				out.cart = &CartChunk{Raw: append([]byte(nil), body...)}
			case riffUMID:
				out.umid = trimTrailingZeros(append([]byte(nil), body...))
			}
		}
		if out.empty() {
			return nil
		}
		return out
	}
	out := &bwfView{}
	cursor := int64(12)
	for cursor+8 <= size {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			if hit, ok := scanForwardForWAVBWFChunk(r, cursor+1, size); ok {
				cursor = hit.HeaderAt
				continue
			}
			break
		}
		chunkID := string(hdr[:4])
		dataSize := int64(binary.LittleEndian.Uint32(hdr[4:8]))
		dataStart := cursor + 8
		if dataSize < 0 || dataStart+dataSize > size {
			if hit, ok := scanForwardForWAVBWFChunk(r, cursor+1, size); ok {
				cursor = hit.HeaderAt
				continue
			}
			break
		}
		switch chunkID {
		case riffBEXT, riffIXML, riffAXML, riffCART, riffUMID:
			body := make([]byte, dataSize)
			if _, err := r.ReadAt(body, dataStart); err != nil {
				if hit, ok := scanForwardForWAVBWFChunk(r, cursor+1, size); ok {
					cursor = hit.HeaderAt
					continue
				}
				break
			}
			switch chunkID {
			case riffBEXT:
				out.ext = parseBEXT(body)
			case riffIXML:
				out.ixml = trimXMLChunk(body)
			case riffAXML:
				out.axml = trimXMLChunk(body)
			case riffCART:
				out.cart = &CartChunk{Raw: append([]byte(nil), body...)}
			case riffUMID:
				out.umid = trimTrailingZeros(append([]byte(nil), body...))
			}
		}
		next := dataStart + dataSize
		if dataSize%2 == 1 {
			next++
		}
		cursor = next
	}
	if out.empty() {
		return nil
	}
	return out
}

func parseBEXT(body []byte) *BroadcastExtension {
	if len(body) == 0 {
		return nil
	}
	out := &BroadcastExtension{}
	if len(body) >= 256 {
		out.Description = trimASCIIField(body[:256])
	}
	if len(body) >= 288 {
		out.Originator = trimASCIIField(body[256:288])
	}
	if len(body) >= 320 {
		out.OriginatorReference = trimASCIIField(body[288:320])
	}
	if len(body) >= 330 {
		out.OriginationDate = trimASCIIField(body[320:330])
	}
	if len(body) >= 338 {
		out.OriginationTime = trimASCIIField(body[330:338])
	}
	if len(body) >= 346 {
		out.TimeReference = binary.LittleEndian.Uint64(body[338:346])
	}
	if len(body) >= 348 {
		out.Version = binary.LittleEndian.Uint16(body[346:348])
	}
	if len(body) >= 412 {
		out.UMID = trimTrailingZeros(append([]byte(nil), body[348:412]...))
	}
	if len(body) >= 422 {
		out.LoudnessValue = int16(binary.LittleEndian.Uint16(body[412:414]))
		out.LoudnessRange = int16(binary.LittleEndian.Uint16(body[414:416]))
		out.MaxTruePeakLevel = int16(binary.LittleEndian.Uint16(body[416:418]))
		out.MaxMomentaryLoudness = int16(binary.LittleEndian.Uint16(body[418:420]))
		out.MaxShortTermLoudness = int16(binary.LittleEndian.Uint16(body[420:422]))
	}
	if len(body) > 602 {
		out.CodingHistory = strings.TrimRight(string(body[602:]), "\x00")
	}
	return out
}

func trimASCIIField(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimRight(string(b), " \t\r\n")
}

func trimXMLChunk(body []byte) string {
	if i := bytes.IndexByte(body, 0); i >= 0 {
		body = body[:i]
	}
	return strings.TrimRight(string(body), "\x00 \t\r\n")
}

func trimTrailingZeros(b []byte) []byte {
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	if len(b) == 0 {
		return nil
	}
	return b
}

func formatUMIDHex(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	return "0x" + strings.ToUpper(hex.EncodeToString(raw))
}

// SetBroadcastExtension installs (or replaces) the typed BWF `bext`
// chunk on a WAV/BWF file. Passing nil removes the chunk entirely.
// The change is flushed on the next Save through the RIFF rewrite
// path. String fields longer than the fixed BWF slot are truncated
// per spec; UMIDs longer than 64 bytes are rejected.
func (f *File) SetBroadcastExtension(ext *BroadcastExtension) error {
	if f.container.Kind() != ContainerWAV {
		return nil
	}
	if f.bwf == nil {
		f.bwf = &bwfView{}
	}
	if ext == nil {
		f.bwf.ext = nil
		f.bwf.dirty = true
		return nil
	}
	if len(ext.UMID) > 64 {
		return fmt.Errorf("mtag: bext UMID is %d bytes, max is 64", len(ext.UMID))
	}
	cp := *ext
	cp.UMID = append([]byte(nil), ext.UMID...)
	f.bwf.ext = &cp
	f.bwf.dirty = true
	return nil
}

// SetBWFIXML installs the iXML XML payload; empty clears the chunk.
func (f *File) SetBWFIXML(s string) {
	if f.container.Kind() != ContainerWAV {
		return
	}
	if f.bwf == nil {
		f.bwf = &bwfView{}
	}
	f.bwf.ixml = s
	f.bwf.dirty = true
}

// SetBWFAXML installs the axml XML payload; empty clears the chunk.
func (f *File) SetBWFAXML(s string) {
	if f.container.Kind() != ContainerWAV {
		return
	}
	if f.bwf == nil {
		f.bwf = &bwfView{}
	}
	f.bwf.axml = s
	f.bwf.dirty = true
}

// SetBWFCart installs the raw cart chunk bytes; nil or empty clears
// the chunk. No structural validation is performed — the cart format
// has a detailed header plus free-form text, and callers that need
// to encode it should build the full byte body themselves.
func (f *File) SetBWFCart(raw []byte) {
	if f.container.Kind() != ContainerWAV {
		return
	}
	if f.bwf == nil {
		f.bwf = &bwfView{}
	}
	if len(raw) == 0 {
		f.bwf.cart = nil
	} else {
		f.bwf.cart = &CartChunk{Raw: append([]byte(nil), raw...)}
	}
	f.bwf.dirty = true
}

// SetBWFUMID installs the standalone `umid` chunk bytes; nil or
// empty clears the chunk. Values longer than 64 bytes are rejected.
func (f *File) SetBWFUMID(raw []byte) error {
	if f.container.Kind() != ContainerWAV {
		return nil
	}
	if len(raw) > 64 {
		return fmt.Errorf("mtag: umid is %d bytes, max is 64", len(raw))
	}
	if f.bwf == nil {
		f.bwf = &bwfView{}
	}
	if len(raw) == 0 {
		f.bwf.umid = nil
	} else {
		f.bwf.umid = append([]byte(nil), raw...)
	}
	f.bwf.dirty = true
	return nil
}

// encodeBEXT serialises a [BroadcastExtension] back into the fixed
// 602-byte header layout plus an optional free-form CodingHistory
// tail. String fields are NUL-padded to their slot size; fields
// longer than their slot are truncated per spec.
func encodeBEXT(ext *BroadcastExtension) []byte {
	out := make([]byte, 602+len(ext.CodingHistory))
	copyASCIIField(out[0:256], ext.Description)
	copyASCIIField(out[256:288], ext.Originator)
	copyASCIIField(out[288:320], ext.OriginatorReference)
	copyASCIIField(out[320:330], ext.OriginationDate)
	copyASCIIField(out[330:338], ext.OriginationTime)
	binary.LittleEndian.PutUint64(out[338:346], ext.TimeReference)
	binary.LittleEndian.PutUint16(out[346:348], ext.Version)
	umid := ext.UMID
	if len(umid) > 64 {
		umid = umid[:64]
	}
	copy(out[348:412], umid)
	binary.LittleEndian.PutUint16(out[412:414], uint16(ext.LoudnessValue))
	binary.LittleEndian.PutUint16(out[414:416], uint16(ext.LoudnessRange))
	binary.LittleEndian.PutUint16(out[416:418], uint16(ext.MaxTruePeakLevel))
	binary.LittleEndian.PutUint16(out[418:420], uint16(ext.MaxMomentaryLoudness))
	binary.LittleEndian.PutUint16(out[420:422], uint16(ext.MaxShortTermLoudness))
	// Bytes 422..602 are the Reserved block; zero-padding is correct.
	copy(out[602:], ext.CodingHistory)
	return out
}

// copyASCIIField copies a string into a fixed-length ASCII slot,
// truncating on overflow and leaving the trailing bytes at zero.
func copyASCIIField(dst []byte, s string) {
	if len(s) > len(dst) {
		s = s[:len(dst)]
	}
	copy(dst, s)
}

// encodeBWFChunks emits the set of BWF-related RIFF sub-chunks as a
// list of (id, body) pairs in the canonical BWF order. Callers are
// responsible for writing the 8-byte chunk headers (LE size field)
// around each body.
func (v *bwfView) encodeChunks() []aiffTextChunk {
	if v == nil {
		return nil
	}
	var out []aiffTextChunk
	if v.ext != nil {
		var id [4]byte
		copy(id[:], riffBEXT)
		out = append(out, aiffTextChunk{id: id, body: encodeBEXT(v.ext)})
	}
	if v.ixml != "" {
		var id [4]byte
		copy(id[:], riffIXML)
		out = append(out, aiffTextChunk{id: id, body: []byte(v.ixml)})
	}
	if v.axml != "" {
		var id [4]byte
		copy(id[:], riffAXML)
		out = append(out, aiffTextChunk{id: id, body: []byte(v.axml)})
	}
	if v.cart != nil && len(v.cart.Raw) > 0 {
		var id [4]byte
		copy(id[:], riffCART)
		out = append(out, aiffTextChunk{id: id, body: append([]byte(nil), v.cart.Raw...)})
	}
	if len(v.umid) > 0 {
		var id [4]byte
		copy(id[:], riffUMID)
		out = append(out, aiffTextChunk{id: id, body: append([]byte(nil), v.umid...)})
	}
	return out
}

type bwfTagView struct{ v *bwfView }

func (v *bwfTagView) Kind() TagKind { return TagBWF }

func (v *bwfTagView) Keys() []string {
	if v.v == nil {
		return nil
	}
	var keys []string
	if v.v.ext != nil {
		keys = append(keys,
			"bext.description",
			"bext.originator",
			"bext.originator_reference",
			"bext.origination_date",
			"bext.origination_time",
			"bext.time_reference",
			"bext.version",
		)
		if len(v.v.ext.UMID) > 0 {
			keys = append(keys, "bext.umid")
		}
		if v.v.ext.CodingHistory != "" {
			keys = append(keys, "bext.coding_history")
		}
		if v.v.ext.LoudnessValue != 0 || v.v.ext.LoudnessRange != 0 ||
			v.v.ext.MaxTruePeakLevel != 0 || v.v.ext.MaxMomentaryLoudness != 0 ||
			v.v.ext.MaxShortTermLoudness != 0 {
			keys = append(keys,
				"bext.loudness_value",
				"bext.loudness_range",
				"bext.max_true_peak_level",
				"bext.max_momentary_loudness",
				"bext.max_short_term_loudness",
			)
		}
	}
	if v.v.ixml != "" {
		keys = append(keys, "ixml")
	}
	if v.v.axml != "" {
		keys = append(keys, "axml")
	}
	if len(v.v.umid) > 0 {
		keys = append(keys, "umid")
	}
	if v.v.cart != nil {
		keys = append(keys, "cart")
	}
	return keys
}

func (v *bwfTagView) Get(name string) string {
	if v.v == nil {
		return ""
	}
	switch strings.ToLower(name) {
	case "bext.description":
		if v.v.ext != nil {
			return v.v.ext.Description
		}
	case "bext.originator":
		if v.v.ext != nil {
			return v.v.ext.Originator
		}
	case "bext.originator_reference":
		if v.v.ext != nil {
			return v.v.ext.OriginatorReference
		}
	case "bext.origination_date":
		if v.v.ext != nil {
			return v.v.ext.OriginationDate
		}
	case "bext.origination_time":
		if v.v.ext != nil {
			return v.v.ext.OriginationTime
		}
	case "bext.time_reference":
		if v.v.ext != nil {
			return strconv.FormatUint(v.v.ext.TimeReference, 10)
		}
	case "bext.version":
		if v.v.ext != nil {
			return strconv.FormatUint(uint64(v.v.ext.Version), 10)
		}
	case "bext.umid":
		if v.v.ext != nil {
			return v.v.ext.UMIDHex()
		}
	case "bext.coding_history":
		if v.v.ext != nil {
			return v.v.ext.CodingHistory
		}
	case "bext.loudness_value":
		if v.v.ext != nil {
			return strconv.FormatInt(int64(v.v.ext.LoudnessValue), 10)
		}
	case "bext.loudness_range":
		if v.v.ext != nil {
			return strconv.FormatInt(int64(v.v.ext.LoudnessRange), 10)
		}
	case "bext.max_true_peak_level":
		if v.v.ext != nil {
			return strconv.FormatInt(int64(v.v.ext.MaxTruePeakLevel), 10)
		}
	case "bext.max_momentary_loudness":
		if v.v.ext != nil {
			return strconv.FormatInt(int64(v.v.ext.MaxMomentaryLoudness), 10)
		}
	case "bext.max_short_term_loudness":
		if v.v.ext != nil {
			return strconv.FormatInt(int64(v.v.ext.MaxShortTermLoudness), 10)
		}
	case "ixml":
		return v.v.ixml
	case "axml":
		return v.v.axml
	case "umid":
		return formatUMIDHex(v.v.umid)
	case "cart":
		if v.v.cart != nil {
			return string(v.v.cart.Raw)
		}
	}
	return ""
}
