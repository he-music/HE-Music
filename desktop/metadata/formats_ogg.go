package metadata

import (
	"encoding/binary"
	"fmt"
)

type oggPayloadPage struct {
	header      [27]byte
	laces       [255]byte
	count       int
	cursor, end int64
}

func (o *oggPayloadStream) readPage(s payloadSource, h *formatPayloadHash, off int64) (oggPayloadPage, error) {
	var page oggPayloadPage
	if err := s.read(off, page.header[:]); err != nil {
		return page, err
	}
	b := page.header[:]
	if string(b[:4]) != "OggS" || b[4] != 0 || b[5]&^byte(7) != 0 {
		return page, ErrInvalidPayload
	}
	if err := o.checkPage(&page, off); err != nil {
		return page, err
	}
	page.count = int(b[26])
	if err := s.read(off+27, page.laces[:page.count]); err != nil {
		return page, err
	}
	page.cursor = off + 27 + int64(page.count)
	page.end = page.cursor
	for _, n := range page.laces[:page.count] {
		page.end += int64(n)
	}
	if page.end > s.size {
		return page, ErrInvalidPayload
	}
	err := checkOggPayloadCRC(s, h, &page)
	return page, err
}

func checkOggPayloadCRC(s payloadSource, h *formatPayloadHash, page *oggPayloadPage) error {
	// Zero only the checksum field; use the existing fixed buffer for the body.
	expected := binary.LittleEndian.Uint32(page.header[22:26])
	clear(page.header[22:26])
	crc := formatOggCRC(0, page.header[:])
	crc = formatOggCRC(crc, page.laces[:page.count])
	buf := h.buffer[:]
	for off := page.cursor; off < page.end; {
		n := min(int64(len(buf)), page.end-off)
		if err := s.read(off, buf[:n]); err != nil {
			return err
		}
		crc = formatOggCRC(crc, buf[:n])
		off += n
	}
	if crc != expected {
		return fmt.Errorf("%w: Ogg CRC", ErrInvalidPayload)
	}
	return nil
}

type oggPayloadStream struct {
	serial, seq        uint32
	packets            int
	pending, skip, eos bool
	packetBytes        int64
	codec              string
}

func (o *oggPayloadStream) checkPage(page *oggPayloadPage, off int64) error {
	b := page.header[:]
	serial, seq := binary.LittleEndian.Uint32(b[14:18]), binary.LittleEndian.Uint32(b[18:22])
	if off == 0 {
		o.serial = serial
		if b[5]&2 == 0 {
			return ErrInvalidPayload
		}
	} else if serial != o.serial || seq != o.seq+1 || b[5]&2 != 0 || o.eos {
		return ErrUnsupportedPayload
	}
	o.seq = seq
	if (b[5]&1 != 0) != o.pending {
		return ErrInvalidPayload
	}
	return nil
}

func oggPayloadCodec(s payloadSource, cursor int64, n byte) (string, error) {
	if n < 8 {
		return "", ErrUnsupportedPayload
	}
	var magic [8]byte
	if err := s.read(cursor, magic[:]); err != nil {
		return "", err
	}
	switch {
	case string(magic[:7]) == "\x01vorbis":
		return "vorbis", nil
	case string(magic[:]) == "OpusHead":
		return "opus", nil
	case string(magic[:]) == "Speex   ":
		return "speex", nil
	default:
		return "", ErrUnsupportedPayload
	}
}

func (o *oggPayloadStream) beginPacket(s payloadSource, h *formatPayloadHash, cursor int64, n byte) error {
	o.skip, o.packetBytes = o.packets == 1, 0
	if o.packets == 0 {
		codec, err := oggPayloadCodec(s, cursor, n)
		if err != nil {
			return err
		}
		o.codec = codec
		h.Write([]byte(codec))
	}
	if o.skip {
		return checkOggCommentPacket(s, o.codec, cursor, n)
	}
	h.Write([]byte("packet"))
	return nil
}

func checkOggCommentPacket(s payloadSource, codec string, cursor int64, n byte) error {
	if codec == "speex" {
		return nil
	}
	want := "OpusTags"
	if codec == "vorbis" {
		want = "\x03vorbis"
	}
	var magic [8]byte
	if int(n) < len(want) {
		return ErrUnsupportedPayload
	}
	if err := s.read(cursor, magic[:len(want)]); err != nil {
		return err
	}
	if string(magic[:len(want)]) != want {
		return ErrInvalidPayload
	}
	return nil
}

func (o *oggPayloadStream) hashPackets(s payloadSource, h *formatPayloadHash, page *oggPayloadPage) (int, error) {
	lastAudioPacket, cursor := -1, page.cursor
	for _, n := range page.laces[:page.count] {
		if !o.pending {
			if err := o.beginPacket(s, h, cursor, n); err != nil {
				return -1, err
			}
		}
		if !o.skip {
			if err := hashFormatRange(s, h, cursor, cursor+int64(n)); err != nil {
				return -1, err
			}
		}
		o.packetBytes += int64(n)
		cursor += int64(n)
		o.pending = n == 255
		if !o.pending {
			if !o.skip {
				var length [8]byte
				binary.BigEndian.PutUint64(length[:], uint64(o.packetBytes))
				h.Write(length[:])
			}
			audioStart := 2
			if o.codec == "vorbis" {
				audioStart = 3
			}
			if o.packets >= audioStart {
				lastAudioPacket = o.packets
			}
			o.packets++
		}
	}
	return lastAudioPacket, nil
}

func (o *oggPayloadStream) hashGranule(h *formatPayloadHash, page *oggPayloadPage, lastAudioPacket int) error {
	o.eos = page.header[5]&4 != 0
	granule := binary.LittleEndian.Uint64(page.header[6:14])
	if lastAudioPacket >= 0 && granule != ^uint64(0) {
		h.Write([]byte("granule"))
		var packet [8]byte
		binary.BigEndian.PutUint64(packet[:], uint64(lastAudioPacket))
		h.Write(packet[:])
		h.Write(page.header[6:14])
	} else if o.eos {
		// EOS needs a completed, positioned audio packet for stable normalization.
		return ErrUnsupportedPayload
	}
	return nil
}
