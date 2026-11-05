package metadata

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

func mp3ID3Extent(s payloadSource) (int64, error) {
	if s.size < 10 {
		return 0, nil
	}
	var h [10]byte
	if err := s.read(0, h[:]); err != nil {
		return 0, err
	}
	if string(h[:3]) != "ID3" {
		return 0, nil
	}
	if (h[3] != 3 && h[3] != 4) || h[4] != 0 {
		return 0, fmt.Errorf("%w: ID3 version", ErrUnsupportedPayload)
	}
	allowed, reserved := byte(0), byte(0x1f)
	if h[3] == 4 {
		allowed, reserved = 0x10, 0x0f
	}
	if h[5]&reserved != 0 {
		return 0, fmt.Errorf("%w: ID3 reserved flags", ErrInvalidPayload)
	}
	if h[5]&^allowed != 0 {
		return 0, fmt.Errorf("%w: ID3 flags", ErrUnsupportedPayload)
	}
	n, err := syncSafe(h[6:])
	if err != nil {
		return 0, err
	}
	start := 10 + n
	if h[5]&0x10 != 0 {
		var footer [10]byte
		if err := s.read(start, footer[:]); err != nil {
			return start, err
		}
		if string(footer[:3]) != "3DI" || !bytes.Equal(footer[3:], h[3:]) {
			return start, fmt.Errorf("%w: ID3 footer", ErrInvalidPayload)
		}
		start += 10
	}
	return start, nil
}

func mp3PayloadBounds(s payloadSource) (payloadSpan, error) {
	p := payloadSpan{kind: "mp3", end: s.size}
	var err error
	p.start, err = mp3ID3Extent(s)
	if err != nil {
		return p, err
	}
	if p.end >= 128 {
		var tag [3]byte
		if err := s.read(p.end-128, tag[:]); err != nil {
			return p, err
		}
		if string(tag[:]) == "TAG" {
			p.end -= 128
		}
	}
	if p.start >= p.end {
		return p, fmt.Errorf("%w: no MPEG frames", ErrInvalidPayload)
	}
	return p, nil
}

type mpegPayloadFrame struct {
	length, side int64
	identity     uint32
	mpeg1, mono  bool
}

func mpegFrameGeometry(v uint32) (length, side int64) {
	version, bi, si := (v>>19)&3, (v>>12)&15, (v>>10)&3
	rate := []int64{44100, 48000, 32000}[si]
	bitrate := []int64{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}[bi]
	factor := int64(144000)
	if version != 3 {
		rate /= 2
		bitrate = []int64{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}[bi]
		factor = 72000
		if version == 0 {
			rate /= 2
		}
	}
	length = factor*bitrate/rate + int64((v>>9)&1)
	side = 32
	if (v>>6)&3 == 3 {
		side = 17
	}
	if version != 3 {
		side = 17
		if (v>>6)&3 == 3 {
			side = 9
		}
	}
	return length, side
}

func readMPEGFrame(s payloadSource, off, end int64) (mpegPayloadFrame, error) {
	var frame mpegPayloadFrame
	var b [4]byte
	if end-off < 4 {
		return frame, fmt.Errorf("%w: truncated MPEG header", ErrInvalidPayload)
	}
	if err := s.read(off, b[:]); err != nil {
		return frame, err
	}
	v := binary.BigEndian.Uint32(b[:])
	version, layer, bi, si := (v>>19)&3, (v>>17)&3, (v>>12)&15, (v>>10)&3
	if v>>21 != 0x7ff {
		return frame, fmt.Errorf("%w: unknown MPEG/trailing bytes at %d", ErrUnsupportedPayload, off)
	}
	if version == 1 || layer == 0 || bi == 15 || si == 3 || v&3 == 2 {
		return frame, fmt.Errorf("%w: MPEG header at %d", ErrInvalidPayload, off)
	}
	if layer != 1 || bi == 0 {
		return frame, fmt.Errorf("%w: MPEG layer/free bitrate", ErrUnsupportedPayload)
	}
	frame.length, frame.side = mpegFrameGeometry(v)
	if v&(1<<16) == 0 {
		return frame, fmt.Errorf("%w: CRC-protected MPEG", ErrUnsupportedPayload)
	}
	if frame.length < 4+frame.side || frame.length > end-off {
		return frame, fmt.Errorf("%w: truncated/short MPEG frame at %d", ErrInvalidPayload, off)
	}
	// Bitrate, padding and stereo mode may vary within a continuous stream.
	frame.identity = v & 0x00180c00
	frame.mono, frame.mpeg1 = (v>>6)&3 == 3, version == 3
	if frame.mono {
		frame.identity |= 1
	}
	return frame, nil
}

func inspectMPEGFrames(s payloadSource, p payloadSpan) error {
	var first uint32
	frames := 0
	var mainBytes, usedBits int64
	var declaredFrames, declaredBytes uint32
	for off := p.start; off < p.end; {
		frame, err := readMPEGFrame(s, off, p.end)
		if err != nil {
			return err
		}
		if frames > 0 && frame.identity != first {
			return fmt.Errorf("%w: changing MPEG stream", ErrUnsupportedPayload)
		}
		first = frame.identity
		if frames == 0 {
			declaredFrames, declaredBytes, err = inspectMPEGVBR(s, off, frame.length, 4+frame.side)
			if err != nil {
				return err
			}
		}
		var sideData [32]byte
		if err := s.read(off+4, sideData[:frame.side]); err != nil {
			return err
		}
		back, partBits, err := inspectMPEGSide(sideData[:frame.side], frame.mpeg1, frame.mono)
		if err != nil {
			return err
		}
		startBits := (mainBytes - back) * 8
		priorMain := mainBytes
		mainBytes += frame.length - 4 - frame.side
		if back > priorMain || startBits < usedBits || startBits+partBits > mainBytes*8 {
			return fmt.Errorf("%w: MPEG bit reservoir", ErrInvalidPayload)
		}
		usedBits = startBits + partBits
		off += frame.length
		frames++
	}
	if declaredFrames != 0 && int64(declaredFrames) != int64(frames-1) || declaredBytes != 0 && int64(declaredBytes) != p.end-p.start {
		return fmt.Errorf("%w: Xing frame/byte count", ErrInvalidPayload)
	}
	if frames < 2 {
		return fmt.Errorf("%w: fewer than two MPEG frames", ErrUnsupportedPayload)
	}
	return nil
}
