package metadata

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

var (
	ErrUnsupportedPayload  = errors.New("metadata: unsupported audio payload layout")
	ErrInvalidPayload      = errors.New("metadata: invalid audio payload")
	ErrAudioPayloadChanged = errors.New("metadata: audio payload changed")
)

// MaxPayloadFileSize bounds work and offset arithmetic. Larger files are refused.
const MaxPayloadFileSize int64 = 1 << 30

type payloadSource struct {
	ctx  context.Context
	r    io.ReaderAt
	size int64
}

func (s payloadSource) read(off int64, p []byte) error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if off < 0 || off > s.size || int64(len(p)) > s.size-off {
		return fmt.Errorf("%w: read outside declared size", ErrInvalidPayload)
	}
	n, err := s.r.ReadAt(p, off)
	if e := s.ctx.Err(); e != nil {
		return e
	}
	if n != len(p) {
		return fmt.Errorf("%w: short read at %d: %v", ErrInvalidPayload, off, err)
	}
	if err != nil && err != io.EOF {
		return err
	}
	return nil
}

type payloadSpan struct {
	kind       string
	start, end int64
	streamInfo [34]byte
}

// CompareAudioPayload validates both layouts independently before comparing the
// complete nonempty audio regions. Readers must remain immutable for this call;
// callers own file identity/version checks and final replacement. No paths,
// metadata parser, external tools or write capabilities are used here.
// Supports native FLAC with a known nonzero sample count and contiguous MPEG
// Layer III with optional leading
// ID3v2.3/2.4 (no extended/unsynchronised/experimental flags) and trailing ID3v1.
// CRC-protected MPEG, APE, ID3v2.2, free-format MPEG, other layers and
// unknown padding are refused. This validates framing, side information and
// FLAC CRCs, not decoded PCM or MPEG Huffman symbols; it is not a decoder.
func CompareAudioPayload(ctx context.Context, left io.ReaderAt, leftSize int64, right io.ReaderAt, rightSize int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if left == nil || right == nil {
		return fmt.Errorf("%w: nil reader", ErrInvalidPayload)
	}
	sources := []payloadSource{{ctx, left, leftSize}, {ctx, right, rightSize}}
	var spans [2]payloadSpan
	var hashes [2][32]byte
	for i, s := range sources {
		if s.size <= 0 || s.size > MaxPayloadFileSize {
			return fmt.Errorf("%w: size must be 1..%d", ErrUnsupportedPayload, MaxPayloadFileSize)
		}
		span, err := inspectPayload(s)
		if canceled := ctx.Err(); canceled != nil {
			return canceled
		}
		if err != nil {
			return fmt.Errorf("payload %d: %w", i, err)
		}
		spans[i] = span
		h := sha256.New()
		buf := make([]byte, 32*1024)
		for off := span.start; off < span.end; {
			n := min(int64(len(buf)), span.end-off)
			if err := s.read(off, buf[:n]); err != nil {
				return err
			}
			h.Write(buf[:n])
			off += n
		}
		copy(hashes[i][:], h.Sum(nil))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if spans[0].kind != spans[1].kind || spans[0].end-spans[0].start != spans[1].end-spans[1].start || spans[0].streamInfo != spans[1].streamInfo || hashes[0] != hashes[1] {
		return ErrAudioPayloadChanged
	}
	return nil
}
func inspectPayload(s payloadSource) (payloadSpan, error) {
	var head [4]byte
	if err := s.read(0, head[:]); err != nil {
		return payloadSpan{}, err
	}
	if string(head[:]) == "fLaC" {
		return inspectFLAC(s)
	}
	return inspectMP3(s)
}
func syncSafe(b []byte) (int64, error) {
	var n int64
	for _, v := range b {
		if v&128 != 0 {
			return 0, fmt.Errorf("%w: non-synchsafe ID3 size", ErrInvalidPayload)
		}
		n = n<<7 | int64(v)
	}
	return n, nil
}
func inspectMP3(s payloadSource) (payloadSpan, error) {
	p := payloadSpan{kind: "mp3", end: s.size}
	var h [10]byte
	if s.size >= 10 {
		if err := s.read(0, h[:]); err != nil {
			return p, err
		}
		if string(h[:3]) == "ID3" {
			if (h[3] != 3 && h[3] != 4) || h[4] != 0 {
				return p, fmt.Errorf("%w: ID3 version", ErrUnsupportedPayload)
			}
			allowed := byte(0)
			if h[3] == 4 {
				allowed = 0x10
			}
			reserved := byte(0x1f)
			if h[3] == 4 {
				reserved = 0x0f
			}
			if h[5]&reserved != 0 {
				return p, fmt.Errorf("%w: ID3 reserved flags", ErrInvalidPayload)
			}
			if h[5]&^allowed != 0 {
				return p, fmt.Errorf("%w: ID3 flags", ErrUnsupportedPayload)
			}
			n, err := syncSafe(h[6:])
			if err != nil {
				return p, err
			}
			p.start = 10 + n
			if h[5]&0x10 != 0 {
				var footer [10]byte
				if err := s.read(p.start, footer[:]); err != nil {
					return p, err
				}
				if string(footer[:3]) != "3DI" || !bytes.Equal(footer[3:], h[3:]) {
					return p, fmt.Errorf("%w: ID3 footer", ErrInvalidPayload)
				}
				p.start += 10
			}
		}
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
	var first uint32
	frames := 0
	var mainBytes, usedBits int64
	var declaredFrames, declaredBytes uint32
	for off := p.start; off < p.end; {
		var b [4]byte
		if p.end-off < 4 {
			return p, fmt.Errorf("%w: truncated MPEG header", ErrInvalidPayload)
		}
		if err := s.read(off, b[:]); err != nil {
			return p, err
		}
		v := binary.BigEndian.Uint32(b[:])
		version := (v >> 19) & 3
		layer := (v >> 17) & 3
		bi := (v >> 12) & 15
		si := (v >> 10) & 3
		if v>>21 != 0x7ff {
			return p, fmt.Errorf("%w: unknown MPEG/trailing bytes at %d", ErrUnsupportedPayload, off)
		}
		if version == 1 || layer == 0 || bi == 15 || si == 3 || v&3 == 2 {
			return p, fmt.Errorf("%w: MPEG header at %d", ErrInvalidPayload, off)
		}
		if layer != 1 || bi == 0 {
			return p, fmt.Errorf("%w: MPEG layer/free bitrate", ErrUnsupportedPayload)
		}
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
		length := factor*bitrate/rate + int64((v>>9)&1)
		side := int64(32)
		if (v>>6)&3 == 3 {
			side = 17
		}
		if version != 3 {
			side = 17
			if (v>>6)&3 == 3 {
				side = 9
			}
		}
		minimum := 4 + side
		if v&(1<<16) == 0 {
			return p, fmt.Errorf("%w: CRC-protected MPEG", ErrUnsupportedPayload)
		}
		if length < minimum || length > p.end-off {
			return p, fmt.Errorf("%w: truncated/short MPEG frame at %d", ErrInvalidPayload, off)
		}
		// Bitrate, padding and stereo mode may vary; version, sample rate and
		// mono/stereo channel count must describe a single continuous stream.
		identity := v & 0x00180c00
		if (v>>6)&3 == 3 {
			identity |= 1
		}
		if frames > 0 && identity != first {
			return p, fmt.Errorf("%w: changing MPEG stream", ErrUnsupportedPayload)
		}
		first = identity
		if frames == 0 {
			var err error
			declaredFrames, declaredBytes, err = inspectMPEGVBR(s, off, length, minimum)
			if err != nil {
				return p, err
			}
		}
		var sideData [32]byte
		if err := s.read(off+4, sideData[:side]); err != nil {
			return p, err
		}
		back, partBits, err := inspectMPEGSide(sideData[:side], version == 3, (v>>6)&3 == 3)
		if err != nil {
			return p, err
		}
		priorMain := mainBytes
		startBits := (priorMain - back) * 8
		mainBytes += length - minimum
		if back > priorMain || startBits < usedBits || startBits+partBits > mainBytes*8 {
			return p, fmt.Errorf("%w: MPEG bit reservoir", ErrInvalidPayload)
		}
		usedBits = startBits + partBits
		off += length
		frames++
	}
	if declaredFrames != 0 && int64(declaredFrames) != int64(frames-1) || declaredBytes != 0 && int64(declaredBytes) != p.end-p.start {
		return p, fmt.Errorf("%w: Xing frame/byte count", ErrInvalidPayload)
	}
	if frames < 2 {
		return p, fmt.Errorf("%w: fewer than two MPEG frames", ErrUnsupportedPayload)
	}
	return p, nil
}

func inspectFLAC(s payloadSource) (payloadSpan, error) {
	p := payloadSpan{kind: "flac", end: s.size}
	off := int64(4)
	blocks := 0
	seen := byte(0)
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
		if typ > 6 {
			return p, fmt.Errorf("%w: FLAC metadata type %d", ErrUnsupportedPayload, typ)
		}
		if blocks == 0 && (typ != 0 || n != 34) || blocks > 0 && typ == 0 {
			return p, fmt.Errorf("%w: FLAC STREAMINFO placement", ErrInvalidPayload)
		}
		if typ == 2 && n < 4 || typ == 3 && n%18 != 0 || typ == 4 && n < 8 || typ == 5 && n < 396 || typ == 6 && n < 32 {
			return p, fmt.Errorf("%w: FLAC metadata block minimum/size", ErrInvalidPayload)
		}
		if (typ == 3 || typ == 4 || typ == 5) && seen&(1<<typ) != 0 {
			return p, fmt.Errorf("%w: duplicate FLAC metadata block", ErrInvalidPayload)
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
	info := p.streamInfo
	minBlock := int(binary.BigEndian.Uint16(info[:2]))
	maxBlock := int(binary.BigEndian.Uint16(info[2:4]))
	packed := binary.BigEndian.Uint64(info[10:18])
	rate := int(packed >> 44)
	channels := int((packed>>41)&7) + 1
	depth := int((packed>>36)&31) + 1
	total := packed & 0xfffffffff
	minFrame := int(info[4])<<16 | int(info[5])<<8 | int(info[6])
	maxFrame := int(info[7])<<16 | int(info[8])<<8 | int(info[9])
	if minBlock < 16 || maxBlock < minBlock || rate == 0 || rate > 655350 || depth < 4 || depth > 32 || total == 0 || minFrame > 0 && maxFrame > 0 && minFrame > maxFrame {
		return p, fmt.Errorf("%w: FLAC STREAMINFO values/unknown total", ErrInvalidPayload)
	}
	if off >= s.size {
		return p, fmt.Errorf("%w: no FLAC frames", ErrInvalidPayload)
	}
	r := bufio.NewReaderSize(io.NewSectionReader(payloadContextReader{s}, off, s.size-off), 32*1024)
	f := flacBits{r: r, ctx: s.ctx, remaining: (s.size - off) * 8}
	samples := uint64(0)
	frames := uint64(0)
	strategy := -1
	nominalBlock := 0
	for samples < total {
		if err := s.ctx.Err(); err != nil {
			return p, err
		}
		start := f.used
		f.crc8 = 0
		f.crc16 = 0
		header := f.bits(32)
		if f.err != nil {
			return p, f.err
		}
		if header>>18 != 0x3ffe || header&(1<<17) != 0 || header&1 != 0 {
			return p, fmt.Errorf("%w: FLAC frame sync/reserved", ErrInvalidPayload)
		}
		mode := int((header >> 16) & 1)
		if strategy >= 0 && mode != strategy {
			return p, fmt.Errorf("%w: FLAC blocking strategy change", ErrUnsupportedPayload)
		}
		strategy = mode
		blockCode := (header >> 12) & 15
		rateCode := (header >> 8) & 15
		assignment := (header >> 4) & 15
		depthCode := (header >> 1) & 7
		if blockCode == 0 || rateCode == 15 || assignment > 10 || depthCode == 3 {
			return p, fmt.Errorf("%w: FLAC frame codes", ErrInvalidPayload)
		}
		number := f.number()
		expected := frames
		if mode == 1 {
			expected = samples
		}
		if number != expected {
			return p, fmt.Errorf("%w: FLAC non-contiguous frame number", ErrInvalidPayload)
		}
		block := 0
		switch blockCode {
		case 1:
			block = 192
		case 2, 3, 4, 5:
			block = 576 << int(blockCode-2)
		case 6:
			block = int(f.bits(8)) + 1
		case 7:
			block = int(f.bits(16)) + 1
		default:
			block = 256 << int(blockCode-8)
		}
		frameRate := rate
		switch rateCode {
		case 0:
		case 12:
			frameRate = int(f.bits(8)) * 1000
		case 13:
			frameRate = int(f.bits(16))
		case 14:
			frameRate = int(f.bits(16)) * 10
		default:
			frameRate = []int{0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000}[rateCode]
		}
		frameDepth := []int{depth, 8, 12, 0, 16, 20, 24, 32}[depthCode]
		frameChannels := int(assignment) + 1
		if assignment >= 8 {
			frameChannels = 2
		}
		if frameRate != rate || frameDepth != depth || frameChannels != channels || block > maxBlock || uint64(block) > total-samples || block < minBlock && samples+uint64(block) != total {
			return p, fmt.Errorf("%w: FLAC frame disagrees with STREAMINFO", ErrInvalidPayload)
		}
		if mode == 0 {
			if nominalBlock == 0 {
				nominalBlock = block
			}
			if block != nominalBlock && (block > nominalBlock || samples+uint64(block) != total) {
				return p, fmt.Errorf("%w: FLAC fixed block size", ErrInvalidPayload)
			}
		}
		crc := f.crc8
		stored := f.bits(8)
		if uint64(crc) != stored {
			return p, fmt.Errorf("%w: FLAC header CRC", ErrInvalidPayload)
		}
		for c := 0; c < channels; c++ {
			bits := depth
			if assignment == 8 && c == 1 || assignment == 9 && c == 0 || assignment == 10 && c == 1 {
				bits++
			}
			f.subframe(block, bits)
		}
		if f.n > 0 {
			if f.bits(f.n) != 0 {
				return p, fmt.Errorf("%w: FLAC padding", ErrInvalidPayload)
			}
		}
		crc16 := f.crc16
		stored = f.bits(16)
		if f.err != nil {
			return p, f.err
		}
		if uint64(crc16) != stored {
			return p, fmt.Errorf("%w: FLAC frame CRC", ErrInvalidPayload)
		}
		length := int((f.used - start) / 8)
		if minFrame > 0 && length < minFrame || maxFrame > 0 && length > maxFrame {
			return p, fmt.Errorf("%w: FLAC frame size bounds", ErrInvalidPayload)
		}
		samples += uint64(block)
		frames++
	}
	if f.remaining != 0 {
		return p, fmt.Errorf("%w: trailing FLAC bytes", ErrUnsupportedPayload)
	}
	return p, nil
}

// The wrapper checks cancellation at each bounded buffered read. A ReaderAt must
// itself return from ReadAt; this API cannot interrupt an arbitrary blocked reader.
type payloadContextReader struct{ s payloadSource }

func (r payloadContextReader) ReadAt(p []byte, off int64) (int, error) {
	if err := r.s.read(off, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

type flacBits struct {
	r               *bufio.Reader
	ctx             context.Context
	remaining, used int64
	value           byte
	n               uint
	crc8            byte
	crc16           uint16
	err             error
}

func (f *flacBits) fail(msg string) {
	if f.err == nil {
		f.err = fmt.Errorf("%w: %s", ErrInvalidPayload, msg)
	}
}
func (f *flacBits) bits(n uint) uint64 {
	if f.err != nil {
		return 0
	}
	if int64(n) > f.remaining {
		f.fail("truncated FLAC bits")
		return 0
	}
	var out uint64
	for n > 0 {
		if f.n == 0 {
			if err := f.ctx.Err(); err != nil {
				f.err = err
				return 0
			}
			b, err := f.r.ReadByte()
			if err != nil {
				f.err = err
				return 0
			}
			f.value = b
			f.n = 8
			f.crc8 ^= b
			f.crc16 ^= uint16(b) << 8
			for i := 0; i < 8; i++ {
				if f.crc8&128 != 0 {
					f.crc8 = f.crc8<<1 ^ 7
				} else {
					f.crc8 <<= 1
				}
				if f.crc16&0x8000 != 0 {
					f.crc16 = f.crc16<<1 ^ 0x8005
				} else {
					f.crc16 <<= 1
				}
			}
		}
		take := min(n, f.n)
		out = out<<take | uint64((f.value>>(f.n-take))&byte((1<<take)-1))
		f.n -= take
		n -= take
		f.remaining -= int64(take)
		f.used += int64(take)
	}
	return out
}
func (f *flacBits) skip(n int64) {
	if n < 0 || n > f.remaining {
		f.fail("FLAC bit length")
		return
	}
	for n > 0 && f.err == nil {
		k := min(n, 64)
		f.bits(uint(k))
		n -= k
	}
}
func (f *flacBits) unary() int64 {
	var n int64
	for f.err == nil {
		if f.bits(1) != 0 {
			return n
		}
		n++
	}
	return n
}
func (f *flacBits) number() uint64 {
	b := f.bits(8)
	if b < 128 {
		return b
	}
	count := 0
	for mask := uint64(128); b&mask != 0 && mask > 0; mask >>= 1 {
		count++
	}
	if count < 2 || count > 7 {
		f.fail("FLAC UTF-8 frame number")
		return 0
	}
	v := b & ((1 << uint(7-count)) - 1)
	for i := 1; i < count; i++ {
		next := f.bits(8)
		if next&192 != 128 {
			f.fail("FLAC UTF-8 continuation")
		}
		v = v<<6 | next&63
	}
	minimum := []uint64{0, 0, 128, 2048, 65536, 2097152, 67108864, 2147483648}[count]
	if v < minimum || v > 0xfffffffff {
		f.fail("FLAC noncanonical frame number")
	}
	return v
}
func (f *flacBits) subframe(samples, depth int) {
	h := f.bits(8)
	if h&128 != 0 {
		f.fail("FLAC subframe reserved bit")
		return
	}
	typ := (h >> 1) & 63
	if h&1 != 0 {
		wasted := f.unary() + 1
		if wasted >= int64(depth) {
			f.fail("FLAC wasted bits")
			return
		}
		depth -= int(wasted)
	}
	order := 0
	switch {
	case typ == 0:
		f.skip(int64(depth))
		return
	case typ == 1:
		f.skip(int64(samples) * int64(depth))
		return
	case typ >= 8 && typ <= 12:
		order = int(typ) - 8
	case typ >= 32:
		order = int(typ&31) + 1
	default:
		f.fail("FLAC reserved subframe")
		return
	}
	if order > samples {
		f.fail("FLAC predictor order")
		return
	}
	f.skip(int64(order) * int64(depth))
	if typ >= 32 {
		precision := f.bits(4) + 1
		if precision == 16 {
			f.fail("FLAC LPC precision")
			return
		}
		f.bits(5)
		f.skip(int64(order) * int64(precision))
	}
	method := f.bits(2)
	if method > 1 {
		f.fail("FLAC residual method")
		return
	}
	parameterBits := uint(4 + method)
	partition := f.bits(4)
	parts := 1 << partition
	if samples%parts != 0 || samples/parts < order {
		f.fail("FLAC residual partition")
		return
	}
	for i := 0; i < parts && f.err == nil; i++ {
		count := samples / parts
		if i == 0 {
			count -= order
		}
		parameter := f.bits(parameterBits)
		if parameter == (1<<parameterBits)-1 {
			width := f.bits(5)
			f.skip(int64(count) * int64(width))
		} else {
			for j := 0; j < count && f.err == nil; j++ {
				f.unary()
				f.skip(int64(parameter))
			}
		}
	}
}

// mpegSideBits only reads the fixed-size Layer III side-information structure.
type mpegSideBits struct {
	data []byte
	pos  uint
}

func (b *mpegSideBits) take(n uint) uint32 {
	var v uint32
	for i := uint(0); i < n; i++ {
		v = v<<1 | uint32((b.data[b.pos/8]>>(7-b.pos%8))&1)
		b.pos++
	}
	return v
}
func inspectMPEGSide(data []byte, mpeg1, mono bool) (int64, int64, error) {
	b := mpegSideBits{data: data}
	channels := 2
	if mono {
		channels = 1
	}
	backBits, privateBits, granules := uint(8), uint(channels), 1
	if mpeg1 {
		backBits = 9
		privateBits = 3
		if mono {
			privateBits = 5
		}
		granules = 2
	}
	back := int64(b.take(backBits))
	b.take(privateBits)
	if mpeg1 {
		b.take(uint(4 * channels))
	}
	var total int64
	invalid := func() (int64, int64, error) { return 0, 0, fmt.Errorf("%w: MPEG side information", ErrInvalidPayload) }
	for g := 0; g < granules; g++ {
		for c := 0; c < channels; c++ {
			total += int64(b.take(12))
			if b.take(9) > 288 {
				return invalid()
			}
			b.take(8)
			if mpeg1 {
				b.take(4)
			} else {
				b.take(9)
			}
			tables := 3
			switched := b.take(1) != 0
			if switched {
				block := b.take(2)
				mixed := b.take(1)
				if block == 0 || mixed != 0 && block != 2 {
					return invalid()
				}
				tables = 2
			}
			for i := 0; i < tables; i++ {
				table := b.take(5)
				if table == 4 || table == 14 {
					return invalid()
				}
			}
			if switched {
				b.take(9)
			} else {
				r0, r1 := b.take(4), b.take(3)
				if r0+r1 > 20 {
					return invalid()
				}
			}
			if mpeg1 {
				b.take(1)
			}
			b.take(2)
		}
	}
	return back, total, nil
}

// Xing/Info occupies audio-frame ancillary bytes and stays in the hash. Its
// counts exclude the Xing frame itself (the byte count includes it). Other
// conventions are conservatively refused; VBRI has no validated support here.
func inspectMPEGVBR(s payloadSource, off, length, headerSize int64) (uint32, uint32, error) {
	var marker [4]byte
	if length >= 40 {
		if err := s.read(off+36, marker[:]); err != nil {
			return 0, 0, err
		}
		if string(marker[:]) == "VBRI" {
			return 0, 0, fmt.Errorf("%w: VBRI", ErrUnsupportedPayload)
		}
	}
	if length < headerSize+4 {
		return 0, 0, nil
	}
	if err := s.read(off+headerSize, marker[:]); err != nil {
		return 0, 0, err
	}
	if string(marker[:]) != "Xing" && string(marker[:]) != "Info" {
		return 0, 0, nil
	}
	var fields [120]byte
	if length < headerSize+8 {
		return 0, 0, fmt.Errorf("%w: Xing flags", ErrInvalidPayload)
	}
	if err := s.read(off+headerSize+4, fields[:4]); err != nil {
		return 0, 0, err
	}
	flags := binary.BigEndian.Uint32(fields[:4])
	if flags&^uint32(15) != 0 {
		return 0, 0, fmt.Errorf("%w: Xing flags", ErrUnsupportedPayload)
	}
	n := int64(0)
	for bit, width := range []int64{4, 4, 100, 4} {
		if flags&(1<<bit) != 0 {
			n += width
		}
	}
	if n > length-headerSize-8 {
		return 0, 0, fmt.Errorf("%w: truncated Xing fields", ErrInvalidPayload)
	}
	if err := s.read(off+headerSize+8, fields[:n]); err != nil {
		return 0, 0, err
	}
	var frames, size uint32
	pos := 0
	if flags&1 != 0 {
		frames = binary.BigEndian.Uint32(fields[pos:])
		pos += 4
		if frames == 0 {
			return 0, 0, fmt.Errorf("%w: zero Xing frames", ErrInvalidPayload)
		}
	}
	if flags&2 != 0 {
		size = binary.BigEndian.Uint32(fields[pos:])
		if size == 0 {
			return 0, 0, fmt.Errorf("%w: zero Xing bytes", ErrInvalidPayload)
		}
	}
	return frames, size, nil
}
