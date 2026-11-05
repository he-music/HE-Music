package metadata

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
)

func validFLACMetadataSize(typ byte, n int64) bool {
	switch typ {
	case 2:
		return n >= 4
	case 3:
		return n%18 == 0
	case 4:
		return n >= 8
	case 5:
		return n >= 396
	case 6:
		return n >= 32
	default:
		return true
	}
}

func checkFLACMetadataBlock(typ byte, n int64, blocks int, seen byte) error {
	if typ > 6 {
		return fmt.Errorf("%w: FLAC metadata type %d", ErrUnsupportedPayload, typ)
	}
	if blocks == 0 && (typ != 0 || n != 34) || blocks > 0 && typ == 0 {
		return fmt.Errorf("%w: FLAC STREAMINFO placement", ErrInvalidPayload)
	}
	if !validFLACMetadataSize(typ, n) {
		return fmt.Errorf("%w: FLAC metadata block minimum/size", ErrInvalidPayload)
	}
	if (typ == 3 || typ == 4 || typ == 5) && seen&(1<<typ) != 0 {
		return fmt.Errorf("%w: duplicate FLAC metadata block", ErrInvalidPayload)
	}
	return nil
}

func readFLACMetadata(s payloadSource) (payloadSpan, error) {
	p := payloadSpan{kind: "flac", end: s.size}
	off, blocks, seen := int64(4), 0, byte(0)
	for {
		var h [4]byte
		if err := s.read(off, h[:]); err != nil {
			return p, err
		}
		off += 4
		typ := h[0] & 127
		n := int64(h[1])<<16 | int64(h[2])<<8 | int64(h[3])
		if n > s.size-off {
			return p, fmt.Errorf("%w: FLAC metadata length", ErrInvalidPayload)
		}
		if err := checkFLACMetadataBlock(typ, n, blocks, seen); err != nil {
			return p, err
		}
		seen |= 1 << typ
		if blocks == 0 {
			if err := s.read(off, p.streamInfo[:]); err != nil {
				return p, err
			}
		}
		off += n
		blocks++
		if blocks > 65536 {
			return p, fmt.Errorf("%w: too many FLAC metadata blocks", ErrUnsupportedPayload)
		}
		if h[0]&128 != 0 {
			break
		}
	}
	p.start = off
	return p, nil
}

type flacStreamInfo struct {
	minBlock, maxBlock    int
	rate, channels, depth int
	minFrame, maxFrame    int
	total                 uint64
}

func parseFLACStreamInfo(b [34]byte) (flacStreamInfo, error) {
	packed := binary.BigEndian.Uint64(b[10:18])
	info := flacStreamInfo{
		minBlock: int(binary.BigEndian.Uint16(b[:2])), maxBlock: int(binary.BigEndian.Uint16(b[2:4])),
		rate: int(packed >> 44), channels: int((packed>>41)&7) + 1, depth: int((packed>>36)&31) + 1,
		total:    packed & 0xfffffffff,
		minFrame: int(b[4])<<16 | int(b[5])<<8 | int(b[6]),
		maxFrame: int(b[7])<<16 | int(b[8])<<8 | int(b[9]),
	}
	if info.minBlock < 16 || info.maxBlock < info.minBlock || info.rate == 0 || info.rate > 655350 || info.depth < 4 || info.depth > 32 || info.total == 0 || info.minFrame > 0 && info.maxFrame > 0 && info.minFrame > info.maxFrame {
		return info, fmt.Errorf("%w: FLAC STREAMINFO values/unknown total", ErrInvalidPayload)
	}
	return info, nil
}

func (i flacStreamInfo) matchesFrame(block, rate, depth, channels int, samples uint64) bool {
	return rate == i.rate && depth == i.depth && channels == i.channels && block <= i.maxBlock && uint64(block) <= i.total-samples && (block >= i.minBlock || samples+uint64(block) == i.total)
}

type flacPayloadFrame struct {
	block      int
	assignment uint64
}

type flacPayloadValidator struct {
	bits                   *flacBits
	info                   flacStreamInfo
	samples, frames        uint64
	strategy, nominalBlock int
}

func (f *flacBits) frameBlockSize(code uint64) int {
	switch code {
	case 1:
		return 192
	case 2, 3, 4, 5:
		return 576 << int(code-2)
	case 6:
		return int(f.bits(8)) + 1
	case 7:
		return int(f.bits(16)) + 1
	default:
		return 256 << int(code-8)
	}
}

func (f *flacBits) frameSampleRate(code uint64, streamRate int) int {
	switch code {
	case 0:
		return streamRate
	case 12:
		return int(f.bits(8)) * 1000
	case 13:
		return int(f.bits(16))
	case 14:
		return int(f.bits(16)) * 10
	default:
		return []int{0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000}[code]
	}
}

func (v *flacPayloadValidator) validFixedBlock(mode, block int) bool {
	if mode != 0 {
		return true
	}
	if v.nominalBlock == 0 {
		v.nominalBlock = block
	}
	return block == v.nominalBlock || block <= v.nominalBlock && v.samples+uint64(block) == v.info.total
}

func (v *flacPayloadValidator) readHeader() (flacPayloadFrame, error) {
	f, info := v.bits, v.info
	var frame flacPayloadFrame
	f.crc8, f.crc16 = 0, 0
	header := f.bits(32)
	if f.err != nil {
		return frame, f.err
	}
	if header>>18 != 0x3ffe || header&(1<<17) != 0 || header&1 != 0 {
		return frame, fmt.Errorf("%w: FLAC frame sync/reserved", ErrInvalidPayload)
	}
	mode := int((header >> 16) & 1)
	if v.strategy >= 0 && mode != v.strategy {
		return frame, fmt.Errorf("%w: FLAC blocking strategy change", ErrUnsupportedPayload)
	}
	v.strategy = mode
	blockCode, rateCode := (header>>12)&15, (header>>8)&15
	frame.assignment = (header >> 4) & 15
	depthCode := (header >> 1) & 7
	if blockCode == 0 || rateCode == 15 || frame.assignment > 10 || depthCode == 3 {
		return frame, fmt.Errorf("%w: FLAC frame codes", ErrInvalidPayload)
	}
	number, expected := f.number(), v.frames
	if mode == 1 {
		expected = v.samples
	}
	if number != expected {
		return frame, fmt.Errorf("%w: FLAC non-contiguous frame number", ErrInvalidPayload)
	}
	frame.block = f.frameBlockSize(blockCode)
	rate := f.frameSampleRate(rateCode, info.rate)
	depth := []int{info.depth, 8, 12, 0, 16, 20, 24, 32}[depthCode]
	channels := int(frame.assignment) + 1
	if frame.assignment >= 8 {
		channels = 2
	}
	if !info.matchesFrame(frame.block, rate, depth, channels, v.samples) {
		return frame, fmt.Errorf("%w: FLAC frame disagrees with STREAMINFO", ErrInvalidPayload)
	}
	if !v.validFixedBlock(mode, frame.block) {
		return frame, fmt.Errorf("%w: FLAC fixed block size", ErrInvalidPayload)
	}
	crc := f.crc8
	if uint64(crc) != f.bits(8) {
		return frame, fmt.Errorf("%w: FLAC header CRC", ErrInvalidPayload)
	}
	return frame, nil
}

func (v *flacPayloadValidator) readFrameData(frame flacPayloadFrame, start int64) error {
	f, info := v.bits, v.info
	for c := range info.channels {
		bits := info.depth
		if frame.assignment == 8 && c == 1 || frame.assignment == 9 && c == 0 || frame.assignment == 10 && c == 1 {
			bits++
		}
		f.subframe(frame.block, bits)
	}
	if f.n > 0 && f.bits(f.n) != 0 {
		return fmt.Errorf("%w: FLAC padding", ErrInvalidPayload)
	}
	crc := f.crc16
	stored := f.bits(16)
	if f.err != nil {
		return f.err
	}
	if uint64(crc) != stored {
		return fmt.Errorf("%w: FLAC frame CRC", ErrInvalidPayload)
	}
	length := int((f.used - start) / 8)
	if info.minFrame > 0 && length < info.minFrame || info.maxFrame > 0 && length > info.maxFrame {
		return fmt.Errorf("%w: FLAC frame size bounds", ErrInvalidPayload)
	}
	return nil
}

func inspectFLACFrames(s payloadSource, p payloadSpan, info flacStreamInfo) error {
	if p.start >= s.size {
		return fmt.Errorf("%w: no FLAC frames", ErrInvalidPayload)
	}
	r := bufio.NewReaderSize(io.NewSectionReader(payloadContextReader{s}, p.start, s.size-p.start), 32*1024)
	bits := flacBits{r: r, ctx: s.ctx, remaining: (s.size - p.start) * 8}
	v := flacPayloadValidator{bits: &bits, info: info, strategy: -1}
	for v.samples < info.total {
		if err := s.ctx.Err(); err != nil {
			return err
		}
		start := bits.used
		frame, err := v.readHeader()
		if err != nil {
			return err
		}
		if err := v.readFrameData(frame, start); err != nil {
			return err
		}
		v.samples += uint64(frame.block)
		v.frames++
	}
	if bits.remaining != 0 {
		return fmt.Errorf("%w: trailing FLAC bytes", ErrUnsupportedPayload)
	}
	return nil
}
