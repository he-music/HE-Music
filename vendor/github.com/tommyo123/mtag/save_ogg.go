package mtag

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/tommyo123/mtag/flac"
)

// oggCRCTable is the precomputed 256-entry CRC-32 table OGG pages
// use. Polynomial 0x04C11DB7, non-reflected, initial 0, no xor-out.
var oggCRCTable [256]uint32

func init() {
	const poly uint32 = 0x04C11DB7
	for i := 0; i < 256; i++ {
		r := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ poly
			} else {
				r <<= 1
			}
		}
		oggCRCTable[i] = r
	}
}

// oggCRC computes the CRC over a full OGG page (with the CRC field
// zeroed before calling).
func oggCRC(page []byte) uint32 {
	var crc uint32
	for _, b := range page {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	return crc
}

// oggRawPage is a raw page as it sits on disk: header bytes plus
// body bytes. Accessors below expose the interesting fields.
type oggRawPage struct {
	offset int64
	header []byte // 27 + nSegments bytes, mutable
	body   []byte // sum(segments) bytes
}

func (p *oggRawPage) headerType() byte     { return p.header[5] }
func (p *oggRawPage) granule() int64       { return int64(binary.LittleEndian.Uint64(p.header[6:14])) }
func (p *oggRawPage) serial() uint32       { return binary.LittleEndian.Uint32(p.header[14:18]) }
func (p *oggRawPage) sequence() uint32     { return binary.LittleEndian.Uint32(p.header[18:22]) }
func (p *oggRawPage) nSegments() int       { return int(p.header[26]) }
func (p *oggRawPage) segmentTable() []byte { return p.header[27 : 27+p.nSegments()] }

func (p *oggRawPage) setSequence(v uint32) { binary.LittleEndian.PutUint32(p.header[18:22], v) }

// recomputeCRC zeros the CRC field, walks header + body, and stores
// the resulting value back in bytes 22–25.
func (p *oggRawPage) recomputeCRC() {
	for i := 22; i < 26; i++ {
		p.header[i] = 0
	}
	// CRC is over header + body with the CRC field zeroed.
	var crc uint32
	for _, b := range p.header {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	for _, b := range p.body {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	binary.LittleEndian.PutUint32(p.header[22:26], crc)
}

// readOGGPages walks every page of the file, returning them in
// order. The walker is deliberately tolerant: once it can no longer
// parse a full page it returns the valid prefix, so trailing
// non-OGG padding (common: zeroed tails after an EOS page) and
// truncated final pages don't prevent a rewrite of the preceding
// metadata.
func readOGGPages(data []byte) ([]oggRawPage, error) {
	var out []oggRawPage
	cur := 0
	for cur+27 <= len(data) {
		if string(data[cur:cur+4]) != "OggS" {
			// Trailing garbage after a valid stream is common; stop
			// cleanly and return the pages read so far.
			return out, nil
		}
		n := int(data[cur+26])
		if cur+27+n > len(data) {
			return out, nil // header claims more segments than remain
		}
		header := make([]byte, 27+n)
		copy(header, data[cur:cur+27+n])
		bodyLen := 0
		for _, s := range header[27 : 27+n] {
			bodyLen += int(s)
		}
		if cur+27+n+bodyLen > len(data) {
			// Truncated final page (file was cut off mid-body).
			// Salvage what came before.
			return out, nil
		}
		body := make([]byte, bodyLen)
		copy(body, data[cur+27+n:cur+27+n+bodyLen])
		out = append(out, oggRawPage{offset: int64(cur), header: header, body: body})
		cur += 27 + n + bodyLen
	}
	return out, nil
}

func readOGGRawPageAt(r io.ReaderAt, offset, size int64) (oggRawPage, int64, error) {
	if offset+27 > size {
		return oggRawPage{}, 0, io.ErrUnexpectedEOF
	}
	var head [27]byte
	if _, err := r.ReadAt(head[:], offset); err != nil {
		return oggRawPage{}, 0, err
	}
	if string(head[:4]) != "OggS" {
		return oggRawPage{}, 0, fmt.Errorf("ogg: missing page magic at %d", offset)
	}
	nSeg := int(head[26])
	if offset+27+int64(nSeg) > size {
		return oggRawPage{}, 0, io.ErrUnexpectedEOF
	}
	header := make([]byte, 27+nSeg)
	copy(header, head[:])
	if nSeg > 0 {
		if _, err := r.ReadAt(header[27:], offset+27); err != nil {
			return oggRawPage{}, 0, err
		}
	}
	bodyLen := 0
	for _, s := range header[27:] {
		bodyLen += int(s)
	}
	if offset+int64(len(header))+int64(bodyLen) > size {
		return oggRawPage{}, 0, io.ErrUnexpectedEOF
	}
	body := make([]byte, bodyLen)
	if bodyLen > 0 {
		if _, err := r.ReadAt(body, offset+int64(len(header))); err != nil {
			return oggRawPage{}, 0, err
		}
	}
	page := oggRawPage{offset: offset, header: header, body: body}
	return page, int64(len(header) + len(body)), nil
}

// oggStreamLayout captures the per-stream book-keeping we need to
// rewrite the comment packet. endPacketIndex is the index (in the
// packets slice) of the last metadata packet (packet 3 for Vorbis,
// packet 2 for Opus which has no setup header).
type oggStreamLayout struct {
	serial            uint32
	metaEndPageIndex  int // index into pages where the last metadata packet ends
	metaIsVorbis      bool
	metaIsOpus        bool
	metaIsSpeex       bool
	metaIsFLAC        bool
	packets           [][]byte // first two or three metadata packets
	firstAudioPageSeq uint32
}

func scanOGGRewriteLayout(r io.ReaderAt, size int64) (*oggStreamLayout, int64, error) {
	const maxPagesScanned = 1024
	layout := &oggStreamLayout{}
	cursor := int64(0)
	var current []byte
	expectedMeta := 0

	for pageNum := 0; pageNum < maxPagesScanned && cursor+27 <= size; pageNum++ {
		page, pageLen, err := readOGGRawPageAt(r, cursor, size)
		if err != nil {
			next, ok := scanForwardForOGGPage(r, cursor+1, size)
			if !ok {
				break
			}
			cursor = next
			continue
		}
		if layout.serial == 0 {
			layout.serial = page.serial()
		}
		segs := page.segmentTable()
		off := 0
		for segIdx, s := range segs {
			current = append(current, page.body[off:off+int(s)]...)
			off += int(s)
			if s == 255 {
				continue
			}
			if len(current) == 0 {
				continue
			}
			packet := append([]byte(nil), current...)
			layout.packets = append(layout.packets, packet)
			current = nil
			if expectedMeta == 0 {
				switch {
				case len(packet) >= 7 && packet[0] == 0x01 && string(packet[1:7]) == "vorbis":
					expectedMeta = 3
					layout.metaIsVorbis = true
				case len(packet) >= 8 && string(packet[:8]) == "OpusHead":
					expectedMeta = 2
					layout.metaIsOpus = true
				case len(packet) >= 8 && string(packet[:8]) == "Speex   ":
					expectedMeta = 2
					layout.metaIsSpeex = true
				case len(packet) >= 5 && packet[0] == 0x7F && string(packet[1:5]) == "FLAC":
					expectedMeta = 2
					layout.metaIsFLAC = true
				default:
					return nil, 0, errors.New("ogg: unrecognised codec (only Vorbis, Opus, Speex and Ogg-FLAC are supported)")
				}
			}
			if len(layout.packets) == expectedMeta {
				if segIdx != len(segs)-1 || off != len(page.body) {
					return nil, 0, errors.New("ogg: metadata packet shares a page with audio — mtag cannot rewrite this layout yet")
				}
				layout.metaEndPageIndex = pageNum
				return layout, cursor + pageLen, nil
			}
		}
		cursor += pageLen
	}
	return nil, 0, errors.New("ogg: metadata packets not complete in stream")
}

// assembleOGGMeta walks pages for a single-stream file and picks
// the metadata packets out of the segment stream. It returns the
// packets, the index of the page that ends the last metadata
// packet, and the total audio-byte length consumed. If the end of
// the last metadata packet does not coincide with a page boundary,
// the operation is not supported yet and an error is returned.
func assembleOGGMeta(pages []oggRawPage) (*oggStreamLayout, error) {
	if len(pages) == 0 {
		return nil, errors.New("ogg: empty stream")
	}
	layout := &oggStreamLayout{serial: pages[0].serial()}

	// Step 1: peek at the first packet's magic to decide how many
	// metadata packets to expect.
	var firstBody []byte
	for _, p := range pages {
		firstBody = append(firstBody, p.body...)
		segs := p.segmentTable()
		// We only need enough bytes to inspect the magic.
		if len(firstBody) >= 8 || (len(segs) > 0 && segs[len(segs)-1] < 255) {
			break
		}
	}
	var expectedMeta int
	switch {
	case len(firstBody) >= 7 && firstBody[0] == 0x01 && string(firstBody[1:7]) == "vorbis":
		expectedMeta = 3
		layout.metaIsVorbis = true
	case len(firstBody) >= 8 && string(firstBody[:8]) == "OpusHead":
		expectedMeta = 2
		layout.metaIsOpus = true
	case len(firstBody) >= 8 && string(firstBody[:8]) == "Speex   ":
		expectedMeta = 2
		layout.metaIsSpeex = true
	case len(firstBody) >= 5 && firstBody[0] == 0x7F && string(firstBody[1:5]) == "FLAC":
		expectedMeta = 2
		layout.metaIsFLAC = true
	default:
		return nil, errors.New("ogg: unrecognised codec (only Vorbis, Opus, Speex and Ogg-FLAC are supported)")
	}

	// Step 2: walk segments globally, splitting into packets.
	var current []byte
	packetsSeen := 0
	for pageIdx, p := range pages {
		segs := p.segmentTable()
		off := 0
		for _, s := range segs {
			current = append(current, p.body[off:off+int(s)]...)
			off += int(s)
			if s < 255 {
				if len(current) > 0 {
					layout.packets = append(layout.packets, current)
					current = nil
					packetsSeen++
					if packetsSeen == expectedMeta {
						// Validate: the terminating segment must
						// be the LAST segment of the page, so the
						// next page is pure audio.
						if s == segs[len(segs)-1] && off == len(p.body) {
							layout.metaEndPageIndex = pageIdx
							if pageIdx+1 < len(pages) {
								layout.firstAudioPageSeq = pages[pageIdx+1].sequence()
							}
							return layout, nil
						}
						return nil, errors.New("ogg: metadata packet shares a page with audio — mtag cannot rewrite this layout yet")
					}
				}
			}
		}
	}
	return nil, errors.New("ogg: metadata packets not complete in stream")
}

// emitOGGMetaPages serialises a metadata packet (ID header, comment,
// or setup) into one or more fresh OGG pages. granule is always 0
// for metadata packets per the Vorbis/Opus specs.
func emitOGGMetaPages(w *oggPageWriter, packet []byte, granule int64, bos bool) error {
	// Split the packet into 255-byte segments. A packet smaller
	// than 255 bytes still needs a terminating <255 segment, so a
	// zero-length segment is appended for packets whose size is an
	// exact multiple of 255.
	cur := 0
	pageSegments := []byte{}
	pageBody := []byte{}
	flushPage := func(last bool) error {
		if err := w.write(pageSegments, pageBody, granule, bos, last); err != nil {
			return err
		}
		bos = false
		pageSegments = nil
		pageBody = nil
		return nil
	}
	for cur < len(packet) {
		n := len(packet) - cur
		if n > 255 {
			n = 255
		}
		pageSegments = append(pageSegments, byte(n))
		pageBody = append(pageBody, packet[cur:cur+n]...)
		cur += n
		// Flush when segment count hits 255 (maximum per page).
		if len(pageSegments) == 255 {
			if err := flushPage(false); err != nil {
				return err
			}
		}
	}
	// Terminator if packet size is an exact multiple of 255.
	if len(packet) > 0 && len(packet)%255 == 0 {
		pageSegments = append(pageSegments, 0)
	}
	if len(pageSegments) > 0 {
		return flushPage(true)
	}
	return nil
}

// oggPageWriter emits pages to an output buffer with correct
// headers, sequence numbers and CRCs.
type oggPageWriter struct {
	dst      io.Writer
	serial   uint32
	sequence uint32
}

func (w *oggPageWriter) write(segments, body []byte, granule int64, bos, lastOfPacket bool) error {
	var hdr [27]byte
	copy(hdr[0:4], "OggS")
	hdr[4] = 0 // version
	var ht byte
	if bos {
		ht |= 0x02
	}
	if !lastOfPacket {
		// Continued packet on next page — but this is the last
		// segment of the current page containing a continuation.
		// We never set the "continued-from-previous" bit here
		// because our caller flushes packet-by-packet.
	}
	hdr[5] = ht
	binary.LittleEndian.PutUint64(hdr[6:14], uint64(granule))
	binary.LittleEndian.PutUint32(hdr[14:18], w.serial)
	binary.LittleEndian.PutUint32(hdr[18:22], w.sequence)
	// hdr[22:26] holds the CRC and is filled after page assembly.
	hdr[26] = byte(len(segments))
	page := append([]byte{}, hdr[:]...)
	page = append(page, segments...)
	page = append(page, body...)
	crc := oggCRC(page)
	binary.LittleEndian.PutUint32(page[22:26], crc)
	if _, err := w.dst.Write(page); err != nil {
		return err
	}
	w.sequence++
	return nil
}

// saveOGG rebuilds an OGG file with the in-memory Vorbis Comment
// replacing its comment packet. Audio pages are copied
// verbatim other than fresh page-sequence fields and CRCs.
func (f *File) saveOGG() error {
	if f.container.Kind() != ContainerOGG {
		return fmt.Errorf("mtag: saveOGG called on %v", f.container.Kind())
	}
	if f.flac == nil {
		if f.oggErr != nil {
			return fmt.Errorf("mtag: ogg comments could not be parsed: %w: %v", ErrInvalidTag, f.oggErr)
		}
		return nil
	}
	layout, audioOffset, err := scanOGGRewriteLayout(f.src, f.size)
	if err != nil {
		return err
	}

	// Build the new comment packet.
	comment := f.flac.comment
	if comment == nil {
		comment = &flac.VorbisComment{Vendor: "mtag"}
	}
	vcBytes := flac.EncodeVorbisComment(comment)
	var newComment []byte
	if layout.metaIsVorbis {
		newComment = append([]byte{0x03}, "vorbis"...)
		newComment = append(newComment, vcBytes...)
		newComment = append(newComment, 0x01) // framing bit
	} else if layout.metaIsOpus {
		newComment = append([]byte("OpusTags"), vcBytes...)
	} else if layout.metaIsFLAC {
		newComment = []byte{0x84, 0, 0, 0}
		blockLen := len(vcBytes)
		newComment[1] = byte(blockLen >> 16)
		newComment[2] = byte(blockLen >> 8)
		newComment[3] = byte(blockLen)
		newComment = append(newComment, vcBytes...)
	} else {
		newComment = append([]byte(nil), vcBytes...)
	}

	var dst io.Writer
	var tmp *os.File
	var tmpPath string
	modTime := f.pathModTime()
	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			w := &oggPageWriter{dst: tmp, serial: layout.serial}
			if err := emitOGGMetaPages(w, layout.packets[0], 0, true); err != nil {
				return err
			}
			if err := emitOGGMetaPages(w, newComment, 0, false); err != nil {
				return err
			}
			if layout.metaIsVorbis && len(layout.packets) >= 3 {
				if err := emitOGGMetaPages(w, layout.packets[2], 0, false); err != nil {
					return err
				}
			}
			if err := f.streamOGGAudioPages(w, audioOffset); err != nil {
				return err
			}
			return nil
		})
	}
	if f.path != "" {
		tmp, tmpPath, err = f.createSiblingTemp()
		if err != nil {
			return err
		}
		dst = tmp
	}
	cleanup := func() {
		if tmp != nil {
			_ = tmp.Close()
		}
		if tmpPath != "" {
			_ = os.Remove(tmpPath)
		}
	}
	w := &oggPageWriter{dst: dst, serial: layout.serial}
	if err := emitOGGMetaPages(w, layout.packets[0], 0, true); err != nil {
		cleanup()
		return err
	}
	if err := emitOGGMetaPages(w, newComment, 0, false); err != nil {
		cleanup()
		return err
	}
	if layout.metaIsVorbis && len(layout.packets) >= 3 {
		if err := emitOGGMetaPages(w, layout.packets[2], 0, false); err != nil {
			cleanup()
			return err
		}
	}
	if err := f.streamOGGAudioPages(w, audioOffset); err != nil {
		cleanup()
		return err
	}

	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	tmp = nil
	_ = f.fd.Close()
	f.fd = nil
	if err := os.Rename(tmpPath, f.path); err != nil {
		if renameBlockedByReader(err) {
			if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
				return nil
			}
		}
		_ = os.Remove(tmpPath)
		if reopen, rerr := os.OpenFile(f.path, os.O_RDWR, 0); rerr == nil {
			f.fd = reopen
			f.src = reopen
			f.rw = reopen
			f.openedRW = true
		}
		return err
	}
	f.applyPathModTime(f.path, modTime)
	reopen, err := os.OpenFile(f.path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	f.fd = reopen
	f.src = reopen
	f.rw = reopen
	f.openedRW = true
	info, err := reopen.Stat()
	if err != nil {
		return err
	}
	f.size = info.Size()
	return nil
}

func (f *File) streamOGGAudioPages(w *oggPageWriter, offset int64) error {
	for cursor := offset; cursor+27 <= f.size; {
		if err := f.checkCtx(); err != nil {
			return err
		}
		page, pageLen, err := readOGGRawPageAt(f.src, cursor, f.size)
		if err != nil {
			return nil
		}
		page.setSequence(w.sequence)
		page.recomputeCRC()
		if _, err := w.dst.Write(page.header); err != nil {
			return err
		}
		if _, err := w.dst.Write(page.body); err != nil {
			return err
		}
		w.sequence++
		cursor += pageLen
	}
	return nil
}
