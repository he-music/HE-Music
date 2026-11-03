package mtag

import (
	"errors"
	"fmt"
	"io"

	"github.com/tommyo123/mtag/flac"
)

// scanForwardForOGGPage searches for the next "OggS" capture
// pattern from the supplied offset onward. Used to resynchronise a
// read after a malformed page header/body so one bad page does not
// hide a later comment packet.
func scanForwardForOGGPage(r io.ReaderAt, from, size int64) (int64, bool) {
	const (
		window  = 64 << 10
		overlap = 3
	)
	if from < 0 {
		from = 0
	}
	buf := make([]byte, window+overlap)
	for base := from; base+4 <= size; {
		readLen := int(size - base)
		if readLen > len(buf) {
			readLen = len(buf)
		}
		n, err := r.ReadAt(buf[:readLen], base)
		if n < 4 {
			return 0, false
		}
		if err != nil && err != io.EOF {
			return 0, false
		}
		for i := 0; i+4 <= n; i++ {
			if buf[i] == 'O' && buf[i+1] == 'g' && buf[i+2] == 'g' && buf[i+3] == 'S' {
				return base + int64(i), true
			}
		}
		if base+int64(n) >= size || n <= 4 {
			return 0, false
		}
		base += int64(n - overlap)
	}
	return 0, false
}

// readOGGComments scans the first few OGG pages of r, reassembles
// the second packet (which carries the Vorbis / Opus / Speex comment
// header), peels off the codec-specific magic prefix and returns the
// resulting Vorbis Comment view.
//
// OGG itself is a stream of pages; logical packets can span page
// boundaries via the segment table. The comment packet is small
// enough in practice to fit into one or two pages, so we read up to
// 16 pages defensively and stop once the packet ends.
const maxOGGPacketBytes = 16 << 20

func readOGGComments(r io.ReaderAt, size int64) (*flacView, error) {
	return readOGGCommentsWithOptions(r, size, false)
}

func readOGGCommentsWithOptions(r io.ReaderAt, size int64, skipPictures bool) (*flacView, error) {
	// Comment packets are usually small, but can balloon when they
	// carry an AcoustID fingerprint or embedded base64 cover-art.
	// 1024 pages × ~8 KiB body each is ~8 MiB of metadata — far
	// more than any sane file but still bounded so a malformed
	// input cannot make us spin forever.
	const maxPagesScanned = 1024

	// Collect logical packets in the order they appear. We need at
	// most the first two: the codec ID header and the comment
	// header.
	var packets [][]byte
	var current []byte
	cursor := int64(0)
	for page := 0; page < maxPagesScanned; page++ {
		header, segments, err := readOGGPageHeader(r, cursor, size)
		if err != nil {
			next, ok := scanForwardForOGGPage(r, cursor+1, size)
			if !ok {
				break
			}
			cursor = next
			continue
		}
		// Sum segment lengths to find the body extent.
		bodyLen := int64(0)
		for _, s := range segments {
			bodyLen += int64(s)
		}
		body := make([]byte, bodyLen)
		bodyOff := cursor + int64(27+len(segments))
		if bodyOff+bodyLen > size {
			next, ok := scanForwardForOGGPage(r, cursor+1, size)
			if !ok {
				break
			}
			cursor = next
			continue
		}
		if bodyLen > 0 {
			if _, err := r.ReadAt(body, bodyOff); err != nil {
				next, ok := scanForwardForOGGPage(r, cursor+1, size)
				if !ok {
					break
				}
				cursor = next
				continue
			}
		}
		// Walk the segment table assembling packets. A packet
		// continues across segments as long as each segment is
		// exactly 255 bytes; a shorter (or zero-length) segment
		// terminates the current packet.
		off := 0
		for _, s := range segments {
			if len(current)+int(s) > maxOGGPacketBytes {
				return nil, fmt.Errorf("ogg: logical packet exceeds size cap")
			}
			current = append(current, body[off:off+int(s)]...)
			off += int(s)
			if s < 255 {
				if len(current) > 0 {
					packets = append(packets, current)
					current = nil
					if len(packets) >= 2 {
						return decodeOGGCommentWithOptions(packets[0], packets[1], skipPictures)
					}
				}
			}
		}
		// Honour the page-end "continued" bit: if the last
		// segment is 255 bytes the packet logically continues
		// into the next page, so we keep `current` as-is and
		// loop.
		_ = header
		cursor += int64(27+len(segments)) + bodyLen
	}
	// We may have a half-finished packet after running out of
	// pages — flush it just in case.
	if len(current) > 0 {
		packets = append(packets, current)
	}
	if len(packets) >= 2 {
		return decodeOGGCommentWithOptions(packets[0], packets[1], skipPictures)
	}
	return nil, errors.New("ogg: comment packet not found")
}

// readOGGPageHeader reads one OGG page header at offset and returns
// the segment table. Page header layout (27 fixed bytes + N segment
// length bytes):
//
//	"OggS" (4) | version (1) | header_type (1) | granule_pos (8) |
//	serial (4) | page_seq (4) | crc (4) | n_segments (1) |
//	segments[n_segments] (1 byte each)
//
// We don't validate the CRC; mtag only needs the body offsets to
// reassemble packets.
func readOGGPageHeader(r io.ReaderAt, offset, size int64) (headerType byte, segments []byte, err error) {
	if offset+27 > size {
		return 0, nil, io.ErrUnexpectedEOF
	}
	var hdr [27]byte
	if _, err := r.ReadAt(hdr[:], offset); err != nil {
		return 0, nil, err
	}
	if string(hdr[:4]) != "OggS" {
		return 0, nil, fmt.Errorf("ogg: missing page magic at %d", offset)
	}
	headerType = hdr[5]
	nSeg := int(hdr[26])
	if offset+27+int64(nSeg) > size {
		return 0, nil, io.ErrUnexpectedEOF
	}
	segments = make([]byte, nSeg)
	if nSeg > 0 {
		if _, err := r.ReadAt(segments, offset+27); err != nil {
			return 0, nil, err
		}
	}
	return headerType, segments, nil
}

// decodeOGGComment peels the codec-specific header off the comment
// packet and decodes the Vorbis Comment payload.
//
//	Vorbis: 0x03 + "vorbis" + <vorbis comment block> + framing bit
//	Opus:   "OpusTags" + <vorbis comment block>
//	Speex:  <vorbis comment block>
//	Ogg-FLAC: metadata block header (type=4) + <vorbis comment block>
//
// The framing bit at the end of a Vorbis comment packet is
// non-significant for parsing.
func decodeOGGComment(idPacket, packet []byte) (*flacView, error) {
	return decodeOGGCommentWithOptions(idPacket, packet, false)
}

func decodeOGGCommentWithOptions(idPacket, packet []byte, skipPictures bool) (*flacView, error) {
	body := packet
	switch {
	case len(body) >= 7 && body[0] == 0x03 && string(body[1:7]) == "vorbis":
		body = body[7:]
	case len(body) >= 8 && string(body[:8]) == "OpusTags":
		body = body[8:]
	case len(idPacket) >= 8 && string(idPacket[:8]) == "Speex   ":
		// Speex stores a plain Vorbis Comment packet as its second
		// packet, with no packet-local signature prefix.
	case len(idPacket) >= 5 && idPacket[0] == 0x7F && string(idPacket[1:5]) == "FLAC":
		if len(body) < 4 || body[0]&0x7F != 4 {
			return nil, fmt.Errorf("ogg: Ogg-FLAC comment packet is not VORBIS_COMMENT")
		}
		blockLen := int(body[1])<<16 | int(body[2])<<8 | int(body[3])
		if blockLen < 0 || 4+blockLen > len(body) {
			return nil, fmt.Errorf("ogg: truncated Ogg-FLAC comment block")
		}
		body = body[4 : 4+blockLen]
	default:
		return nil, fmt.Errorf("ogg: unrecognised comment magic")
	}
	vc, err := flac.DecodeVorbisCommentWithOptions(body, skipPictures)
	if err != nil {
		return nil, err
	}
	return &flacView{comment: vc}, nil
}
