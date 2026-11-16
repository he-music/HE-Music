package rpm

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"strconv"

	"github.com/klauspost/compress/zstd"
	"github.com/ulikunitz/xz"
	"github.com/ulikunitz/xz/lzma"
)

// parse.go is an independent reverse decoder for RPM headers. It exists so tests
// can read back exactly what the encoder produced (a separate code path catches
// encoder bugs that a same-code round-trip would hide). It is unexported and
// exercised by the *_internal_test.go round-trip tests.

type parsedEntry struct {
	tag     int
	rpmType int
	count   int
	raw     []byte
}

type parsedHeader struct {
	region  int
	entries map[int]parsedEntry
	// total is the number of bytes the on-disk header occupied (magic + intro +
	// index entries + data store), so the caller can advance past it.
	total int
}

// parseHeader decodes one header/signature section starting at the front of b.
func parseHeader(b []byte, wantRegion int) (*parsedHeader, error) {
	if len(b) < 16 {
		return nil, fmt.Errorf("rpm: header too short: %d bytes", len(b))
	}
	for i := range 4 {
		if b[i] != headerMagic[i] {
			return nil, fmt.Errorf("rpm: bad header magic at byte %d: %#x", i, b[i])
		}
	}
	nEntries := int(binary.BigEndian.Uint32(b[8:]))
	dataSize := int(binary.BigEndian.Uint32(b[12:]))
	idxStart := 16
	dataStart := idxStart + nEntries*16
	total := dataStart + dataSize
	if total > len(b) {
		return nil, fmt.Errorf("rpm: header truncated: need %d bytes, have %d", total, len(b))
	}
	store := b[dataStart:total]

	h := &parsedHeader{region: wantRegion, entries: make(map[int]parsedEntry), total: total}
	for n := range nEntries {
		off := idxStart + n*16
		tag := int(int32(binary.BigEndian.Uint32(b[off:])))
		rpmType := int(binary.BigEndian.Uint32(b[off+4:]))
		dataOff := int(int32(binary.BigEndian.Uint32(b[off+8:])))
		count := int(binary.BigEndian.Uint32(b[off+12:]))

		// The region trailer is the entry whose tag equals the region tag with a
		// 16-byte BIN payload. Validate its negative back-offset and skip it.
		if tag == wantRegion && rpmType == typeBin && count == 16 {
			back := int(int32(binary.BigEndian.Uint32(store[dataOff+8:])))
			if want := -(16 * nEntries); back != want {
				return nil, fmt.Errorf("rpm: region back-offset = %d, want %d", back, want)
			}
			continue
		}

		length, err := entryByteLen(store, dataOff, rpmType, count)
		if err != nil {
			return nil, fmt.Errorf("rpm: tag %d: %w", tag, err)
		}
		if dataOff+length > len(store) {
			return nil, fmt.Errorf("rpm: tag %d data out of range", tag)
		}
		h.entries[tag] = parsedEntry{tag: tag, rpmType: rpmType, count: count, raw: store[dataOff : dataOff+length]}
	}
	return h, nil
}

func entryByteLen(store []byte, offset, rpmType, count int) (int, error) {
	switch rpmType {
	case typeChar, typeInt8:
		return count, nil
	case typeInt16:
		return count * 2, nil
	case typeInt32:
		return count * 4, nil
	case typeInt64:
		return count * 8, nil
	case typeBin:
		return count, nil
	case typeString, typeI18NString, typeStringArray:
		n := count
		if rpmType == typeString {
			n = 1
		}
		pos := offset
		for s := 0; s < n; s++ {
			for pos < len(store) && store[pos] != 0 {
				pos++
			}
			if pos >= len(store) {
				return 0, fmt.Errorf("unterminated string element %d", s)
			}
			pos++ // consume NUL
		}
		return pos - offset, nil
	}
	return 0, fmt.Errorf("unknown rpm type %d", rpmType)
}

// --- typed accessors used by tests ---

func (h *parsedHeader) has(tag int) bool {
	_, ok := h.entries[tag]
	return ok
}

func (h *parsedHeader) str(tag int) (string, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return "", false
	}
	raw := e.raw
	if len(raw) > 0 && raw[len(raw)-1] == 0 {
		raw = raw[:len(raw)-1]
	}
	return string(raw), true
}

func (h *parsedHeader) strSlice(tag int) ([]string, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return nil, false
	}
	out := make([]string, 0, e.count)
	start := 0
	for i, c := range e.raw {
		if c == 0 {
			out = append(out, string(e.raw[start:i]))
			start = i + 1
		}
	}
	return out, true
}

func (h *parsedHeader) int32s(tag int) ([]int32, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return nil, false
	}
	out := make([]int32, e.count)
	for i := range out {
		out[i] = int32(binary.BigEndian.Uint32(e.raw[i*4:]))
	}
	return out, true
}

func (h *parsedHeader) uint32s(tag int) ([]uint32, bool) {
	v, ok := h.int32s(tag)
	if !ok {
		return nil, false
	}
	out := make([]uint32, len(v))
	for i := range v {
		out[i] = uint32(v[i])
	}
	return out, true
}

func (h *parsedHeader) uint16s(tag int) ([]uint16, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return nil, false
	}
	out := make([]uint16, e.count)
	for i := range out {
		out[i] = binary.BigEndian.Uint16(e.raw[i*2:])
	}
	return out, true
}

func (h *parsedHeader) int64s(tag int) ([]int64, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return nil, false
	}
	out := make([]int64, e.count)
	for i := range out {
		out[i] = int64(binary.BigEndian.Uint64(e.raw[i*8:]))
	}
	return out, true
}

func (h *parsedHeader) bin(tag int) ([]byte, bool) {
	e, ok := h.entries[tag]
	if !ok {
		return nil, false
	}
	return e.raw, true
}

// --- cpio payload parsing ---

type cpioEntry struct {
	name  string
	mode  uint32
	ino   int
	nlink int
	body  []byte
}

// parseCPIO decodes an uncompressed newc cpio stream, stopping at the trailer.
func parseCPIO(b []byte) ([]cpioEntry, error) {
	var out []cpioEntry
	pos := 0
	for {
		if pos+110 > len(b) {
			return nil, fmt.Errorf("rpm: cpio truncated header at %d", pos)
		}
		if string(b[pos:pos+6]) != cpioMagic {
			return nil, fmt.Errorf("rpm: bad cpio magic at %d: %q", pos, b[pos:pos+6])
		}
		field := func(i int) int {
			v, _ := strconv.ParseUint(string(b[pos+6+i*8:pos+6+i*8+8]), 16, 32)
			return int(v)
		}
		ino := field(0)
		mode := field(1)
		nlink := field(4)
		fileSize := field(6)
		nameSize := field(11)

		nameStart := pos + 110
		if nameStart+nameSize > len(b) {
			return nil, fmt.Errorf("rpm: cpio name out of range at %d", pos)
		}
		name := string(b[nameStart : nameStart+nameSize-1]) // drop trailing NUL
		bodyStart := nameStart + nameSize + int(cpioPad(int64(110+nameSize)))
		if name == cpioTrailerName {
			break
		}
		if bodyStart+fileSize > len(b) {
			return nil, fmt.Errorf("rpm: cpio body out of range for %q", name)
		}
		body := b[bodyStart : bodyStart+fileSize]
		out = append(out, cpioEntry{name: name, mode: uint32(mode), ino: ino, nlink: nlink, body: body})
		pos = bodyStart + fileSize + int(cpioPad(int64(fileSize)))
	}
	return out, nil
}

// --- whole-file parsing ---

type parsedRPM struct {
	lead    []byte
	sig     *parsedHeader
	header  *parsedHeader
	payload []cpioEntry
}

// parseRPM decodes a complete RPM file: lead, signature header, padding, main
// header, and the decompressed cpio payload.
func parseRPM(b []byte) (*parsedRPM, error) {
	if len(b) < leadLength {
		return nil, fmt.Errorf("rpm: file shorter than lead")
	}
	for i := range 4 {
		if b[i] != []byte{0xed, 0xab, 0xee, 0xdb}[i] {
			return nil, fmt.Errorf("rpm: bad lead magic")
		}
	}
	pos := leadLength

	sig, err := parseHeader(b[pos:], regionSignatures)
	if err != nil {
		return nil, fmt.Errorf("rpm: signature header: %w", err)
	}
	pos += sig.total
	// The main header is padded to an 8-byte boundary relative to the start of
	// the signature header (the 96-byte lead is already 8-aligned).
	pos += (8 - sig.total%8) % 8

	header, err := parseHeader(b[pos:], regionImmutable)
	if err != nil {
		return nil, fmt.Errorf("rpm: main header: %w", err)
	}
	pos += header.total

	comp, _ := header.str(tagPayloadCompressor)
	raw, err := decompress(comp, b[pos:])
	if err != nil {
		return nil, fmt.Errorf("rpm: decompressing payload: %w", err)
	}
	entries, err := parseCPIO(raw)
	if err != nil {
		return nil, err
	}
	return &parsedRPM{lead: b[:leadLength], sig: sig, header: header, payload: entries}, nil
}

func decompress(name string, b []byte) ([]byte, error) {
	switch name {
	case "gzip", "":
		r, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	case "xz":
		r, err := xz.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	case "lzma":
		r, err := lzma.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	case "zstd":
		r, err := zstd.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		defer r.Close()
		return io.ReadAll(r)
	default:
		return nil, fmt.Errorf("rpm: unknown compressor %q", name)
	}
}
