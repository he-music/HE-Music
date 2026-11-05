package metadata

import (
	"bufio"
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
	if leftSize <= 0 || rightSize <= 0 {
		return ErrUnsupportedPayload
	}
	additional, err := AdditionalPayloadFormat(ctx, left, leftSize)
	if err != nil {
		return err
	}
	if additional {
		return CompareFormatAudioPayload(ctx, left, leftSize, right, rightSize)
	}
	sources := []payloadSource{{ctx, left, leftSize}, {ctx, right, rightSize}}
	var spans [2]payloadSpan
	var hashes [2][32]byte
	for i, s := range sources {
		if s.size <= 0 {
			return fmt.Errorf("%w: empty file", ErrUnsupportedPayload)
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
	p, err := mp3PayloadBounds(s)
	if err != nil {
		return p, err
	}
	return p, inspectMPEGFrames(s, p)
}

func inspectFLAC(s payloadSource) (payloadSpan, error) {
	p, err := readFLACMetadata(s)
	if err != nil {
		return p, err
	}
	info, err := parseFLACStreamInfo(p.streamInfo)
	if err != nil {
		return p, err
	}
	return p, inspectFLACFrames(s, p, info)
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
			for range 8 {
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
	f.residual(samples, order)
}

func (f *flacBits) residual(samples, order int) {
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
	for range n {
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
