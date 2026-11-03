package mtag

import (
	"bytes"
	"encoding/binary"
	"io"
	"strings"
)

// riffInfoView holds the native metadata chunks that live inside
// RIFF/WAVE and FORM/AIFF files alongside (or instead of) an
// embedded ID3 tag. For WAV the source is a LIST "INFO" subchunk;
// for AIFF it is a set of top-level NAME / AUTH / (c) / ANNO
// chunks. Both map onto the same four-byte key convention here —
// we use uppercase ASCII so lookups are stable regardless of the
// writer's case.
type riffInfoView struct {
	// kind says whether the values come from a WAV INFO LIST
	// (which drives the canonical INFO key set "INAM"/"IART"/…)
	// or from AIFF's top-level text chunks ("NAME"/"AUTH"/"(c) ").
	// Only affects the TagKind reported back through [Tag.Kind]:
	// read-side keys are already canonicalised into upper-case
	// four-byte FourCCs.
	kind ContainerKind
	// keys preserves the on-disk ordering so [Tag.Keys] returns
	// something stable and recognisable.
	keys []string
	// values is the case-canonicalised field table.
	values map[string]string
	// dirty flips to true the first time a caller mutates the view
	// via [Set]. The save path uses it to skip regenerating native
	// chunks when nothing actually changed, preserving the on-disk
	// byte-for-byte form.
	dirty bool
}

// Canonical field names. Constants are uppercase four-byte
// FourCCs so they are searchable both as-written-on-disk and via
// strings.EqualFold.
const (
	// WAV LIST-INFO field names.
	riffINAM = "INAM" // title
	riffIART = "IART" // artist
	riffIPRD = "IPRD" // album / product
	riffICMT = "ICMT" // comment
	riffICRD = "ICRD" // creation date
	riffIGNR = "IGNR" // genre
	riffIPRT = "IPRT" // track / part number
	riffITRK = "ITRK" // track number
	riffICOP = "ICOP" // copyright
	riffIMUS = "IMUS" // composer
	riffIPUB = "IPUB" // publisher / label
	riffITCH = "ITCH" // encoded by
	riffIENG = "IENG" // engineer / arranger
	riffISFT = "ISFT" // software
	// AIFF-specific text chunks. The (c) chunk literal is 0xA9
	// followed by three spaces ("\xa9   "); mtag maps it onto the
	// sentinel "COPY" so it fits the same four-byte key space.
	riffNAME = "NAME"
	riffAUTH = "AUTH"
	riffANNO = "ANNO"
	riffCOPY = "COPY" // logical alias for the AIFF (c) chunk
)

func scanForwardForWAVInfoList(r io.ReaderAt, from, size int64) (chunkSpan, bool) {
	start := from
	for {
		hit, ok := scanForwardForIFFChunk(r, start, size, binary.LittleEndian, func(id [4]byte) bool {
			return string(id[:]) == "LIST"
		})
		if !ok || hit.DataSize < 4 {
			return chunkSpan{}, false
		}
		var listKind [4]byte
		if _, err := r.ReadAt(listKind[:], hit.DataAt); err == nil && string(listKind[:]) == "INFO" {
			return hit, true
		}
		start = hit.HeaderAt + 1
	}
}

func scanForwardForAIFFTextChunk(r io.ReaderAt, from, size int64) (chunkSpan, bool) {
	return scanForwardForIFFChunk(r, from, size, binary.BigEndian, func(id [4]byte) bool {
		switch string(id[:]) {
		case riffNAME, riffAUTH, riffANNO, "\xa9   ":
			return true
		}
		return false
	})
}

// scanWAVInfo walks the chunk list of a WAV file looking for a
// LIST "INFO" subchunk and parses every key inside it. The result
// is a [riffInfoView] whose key set uses the canonical INFO
// FourCCs. Returns nil when no INFO block is present.
func scanWAVInfo(r io.ReaderAt, size int64) *riffInfoView {
	if outer := readIFFOuterMagic(r); isRF64Magic(outer) {
		for _, c := range listIFFChunks(r, size, binary.LittleEndian, outer) {
			if string(c.ID[:]) != "LIST" || c.DataSize < 4 {
				continue
			}
			var listKind [4]byte
			if _, err := r.ReadAt(listKind[:], c.DataAt); err != nil || string(listKind[:]) != "INFO" {
				continue
			}
			body := make([]byte, c.DataSize-4)
			if _, err := r.ReadAt(body, c.DataAt+4); err == nil {
				return parseRIFFInfoSubchunks(body, ContainerWAV)
			}
		}
		return nil
	}
	cursor := int64(12)
	for cursor+8 <= size {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			if hit, ok := scanForwardForWAVInfoList(r, cursor+1, size); ok {
				body := make([]byte, hit.DataSize-4)
				if _, err := r.ReadAt(body, hit.DataAt+4); err == nil {
					return parseRIFFInfoSubchunks(body, ContainerWAV)
				}
			}
			return nil
		}
		chunkID := string(hdr[:4])
		dataSize := int64(binary.LittleEndian.Uint32(hdr[4:8]))
		dataStart := cursor + 8
		if dataSize < 0 || dataStart+dataSize > size {
			if hit, ok := scanForwardForWAVInfoList(r, cursor+1, size); ok {
				body := make([]byte, hit.DataSize-4)
				if _, err := r.ReadAt(body, hit.DataAt+4); err == nil {
					return parseRIFFInfoSubchunks(body, ContainerWAV)
				}
			}
			return nil
		}
		if chunkID == "LIST" && dataSize >= 4 {
			var listKind [4]byte
			if _, err := r.ReadAt(listKind[:], dataStart); err == nil && string(listKind[:]) == "INFO" {
				body := make([]byte, dataSize-4)
				if _, err := r.ReadAt(body, dataStart+4); err != nil {
					if hit, ok := scanForwardForWAVInfoList(r, cursor+1, size); ok {
						body = make([]byte, hit.DataSize-4)
						if _, err := r.ReadAt(body, hit.DataAt+4); err == nil {
							return parseRIFFInfoSubchunks(body, ContainerWAV)
						}
					}
					return nil
				}
				return parseRIFFInfoSubchunks(body, ContainerWAV)
			}
		}
		next := dataStart + dataSize
		if dataSize%2 == 1 {
			next++
		}
		cursor = next
	}
	return nil
}

// parseRIFFInfoSubchunks decodes the contents of a LIST-INFO body:
// a sequence of {FourCC, 4-byte LE size, text}. Strings are
// NUL-terminated per spec; any trailing whitespace is trimmed.
func parseRIFFInfoSubchunks(body []byte, kind ContainerKind) *riffInfoView {
	out := &riffInfoView{kind: kind, values: map[string]string{}}
	cur := 0
	for cur+8 <= len(body) {
		name := strings.ToUpper(string(body[cur : cur+4]))
		dataSize := int(binary.LittleEndian.Uint32(body[cur+4 : cur+8]))
		if dataSize < 0 || cur+8+dataSize > len(body) {
			break
		}
		value := trimRIFFText(body[cur+8 : cur+8+dataSize])
		if _, seen := out.values[name]; !seen {
			out.keys = append(out.keys, name)
		}
		out.values[name] = value
		next := cur + 8 + dataSize
		if dataSize%2 == 1 {
			next++
		}
		cur = next
	}
	if len(out.keys) == 0 {
		return nil
	}
	return out
}

// scanAIFFText walks a FORM/AIFF file at top level looking for
// NAME / AUTH / ANNO / (c) chunks. These carry their text as
// raw BE-sized payloads (no NUL terminator required).
func scanAIFFText(r io.ReaderAt, size int64) *riffInfoView {
	out := &riffInfoView{kind: ContainerAIFF, values: map[string]string{}}
	cursor := int64(12)
	for cursor+8 <= size {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			if hit, ok := scanForwardForAIFFTextChunk(r, cursor+1, size); ok {
				cursor = hit.HeaderAt
				continue
			}
			break
		}
		chunkID := string(hdr[:4])
		dataSize := int64(binary.BigEndian.Uint32(hdr[4:8]))
		dataStart := cursor + 8
		if dataSize < 0 || dataStart+dataSize > size {
			if hit, ok := scanForwardForAIFFTextChunk(r, cursor+1, size); ok {
				cursor = hit.HeaderAt
				continue
			}
			break
		}
		key := ""
		switch chunkID {
		case riffNAME, riffAUTH, riffANNO:
			key = chunkID
		case "\xa9   ":
			key = riffCOPY
		}
		if key != "" {
			body := make([]byte, dataSize)
			if _, err := r.ReadAt(body, dataStart); err == nil {
				value := trimRIFFText(body)
				if _, seen := out.values[key]; !seen {
					out.keys = append(out.keys, key)
				}
				out.values[key] = value
			} else if hit, ok := scanForwardForAIFFTextChunk(r, cursor+1, size); ok {
				cursor = hit.HeaderAt
				continue
			}
		}
		next := dataStart + dataSize
		if dataSize%2 == 1 {
			next++
		}
		cursor = next
	}
	if len(out.keys) == 0 {
		return nil
	}
	return out
}

// trimRIFFText cuts at the first NUL and strips trailing ASCII
// whitespace, matching the convention used by virtually every
// writer that emits the format.
func trimRIFFText(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimRight(string(b), " \t\r\n")
}

// Get returns the text stored under the canonical FourCC key, or
// "" when the field is absent.
func (v *riffInfoView) Get(name string) string {
	if v == nil || v.values == nil {
		return ""
	}
	return v.values[strings.ToUpper(name)]
}

// Set writes a value under the canonical FourCC key. An empty
// value removes the key entirely so the chunk disappears on
// rewrite.
func (v *riffInfoView) Set(name, value string) {
	if v == nil {
		return
	}
	if v.values == nil {
		v.values = map[string]string{}
	}
	key := strings.ToUpper(name)
	if value == "" {
		if _, seen := v.values[key]; seen {
			delete(v.values, key)
			for i, k := range v.keys {
				if k == key {
					v.keys = append(v.keys[:i], v.keys[i+1:]...)
					break
				}
			}
			v.dirty = true
		}
		return
	}
	if cur, seen := v.values[key]; !seen || cur != value {
		if !seen {
			v.keys = append(v.keys, key)
		}
		v.values[key] = value
		v.dirty = true
	}
}

// encodeWAVInfoList returns the byte payload of a RIFF LIST
// subchunk of kind "INFO" built from the current field set. The
// result starts with the 4-byte "INFO" kind followed by one
// sub-chunk per populated field: {4-byte FourCC, LE size,
// NUL-terminated text, optional pad}. Returns nil when the view
// has no WAV-side fields.
func (v *riffInfoView) encodeWAVInfoList() []byte {
	if v == nil {
		return nil
	}
	var body bytes.Buffer
	body.WriteString("INFO")
	written := 0
	for _, key := range v.keys {
		if !isRIFFInfoKey(key) {
			continue
		}
		val := v.values[key]
		if val == "" {
			continue
		}
		body.WriteString(key)
		payload := append([]byte(val), 0)
		var sz [4]byte
		binary.LittleEndian.PutUint32(sz[:], uint32(len(payload)))
		body.Write(sz[:])
		body.Write(payload)
		if len(payload)%2 == 1 {
			body.WriteByte(0)
		}
		written++
	}
	if written == 0 {
		return nil
	}
	return body.Bytes()
}

// encodeAIFFTextChunks returns one {id, body} chunk description
// for each populated AIFF text field in the view's canonical
// order. The caller is responsible for writing the chunk headers
// with big-endian size fields.
func (v *riffInfoView) encodeAIFFTextChunks() []aiffTextChunk {
	if v == nil {
		return nil
	}
	var out []aiffTextChunk
	for _, key := range v.keys {
		val := v.values[key]
		if val == "" {
			continue
		}
		var id [4]byte
		switch key {
		case riffNAME:
			copy(id[:], "NAME")
		case riffAUTH:
			copy(id[:], "AUTH")
		case riffANNO:
			copy(id[:], "ANNO")
		case riffCOPY:
			copy(id[:], "\xa9   ")
		default:
			continue
		}
		out = append(out, aiffTextChunk{id: id, body: []byte(val)})
	}
	return out
}

type aiffTextChunk struct {
	id   [4]byte
	body []byte
}

// isRIFFInfoKey reports whether the key is one of the well-known
// WAV LIST/INFO FourCCs. We still accept unknown four-byte keys
// the original writer emitted — they are preserved through the
// parse/encode round-trip as long as they look like valid FourCCs.
func isRIFFInfoKey(key string) bool {
	if len(key) != 4 {
		return false
	}
	for i := 0; i < 4; i++ {
		c := key[i]
		if c < 0x20 || c > 0x7E {
			return false
		}
	}
	switch key {
	case riffNAME, riffAUTH, riffANNO, riffCOPY:
		return false
	}
	return true
}

// riffInfoTagView adapts a [riffInfoView] to the polymorphic [Tag]
// interface.
type riffInfoTagView struct{ v *riffInfoView }

func (t *riffInfoTagView) Kind() TagKind {
	if t.v == nil || t.v.kind == ContainerAIFF {
		return TagAIFFText
	}
	return TagRIFFInfo
}
func (t *riffInfoTagView) Keys() []string         { return append([]string{}, t.v.keys...) }
func (t *riffInfoTagView) Get(name string) string { return t.v.Get(name) }
