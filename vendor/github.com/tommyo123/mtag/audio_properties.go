package mtag

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"strings"
	"time"

	"github.com/tommyo123/mtag/id3v2"
)

// AudioPropertiesStyle controls how much work [File.AudioProperties]
// is allowed to do on codecs whose duration or bitrate is not fixed in
// a small header.
type AudioPropertiesStyle uint8

const (
	// AudioPropertiesAccurate scans as much of the stream as needed to
	// produce the most reliable duration and bitrate estimate mtag can.
	AudioPropertiesAccurate AudioPropertiesStyle = iota
	// AudioPropertiesAverage prefers bounded scans and summary blocks
	// when the format provides them.
	AudioPropertiesAverage
	// AudioPropertiesFast limits itself to header reads and summary
	// blocks that are available near the start of the stream.
	AudioPropertiesFast
)

func (s AudioPropertiesStyle) String() string {
	switch s {
	case AudioPropertiesAccurate:
		return "accurate"
	case AudioPropertiesAverage:
		return "average"
	case AudioPropertiesFast:
		return "fast"
	}
	return "unknown"
}

// AudioProperties summarises the decoded audio stream's shape:
// duration, bitrate, sample rate, and channel count. Populated
// lazily on the first [File.AudioProperties] call; zero values
// mean "not available for this container" (the field is always
// safe to inspect, it just may read as empty).
type AudioProperties struct {
	Duration   time.Duration
	Bitrate    int // bits per second; 0 when unknown
	SampleRate int // Hz
	Channels   int
	BitDepth   int // bits per sample; 0 when unknown or not applicable
	Codec      string
}

// bitrateBps returns bytes * 8 / duration as bits per second. The
// intermediate product is kept in int64 so large files don't overflow.
func bitrateBps(bytes int64, duration time.Duration) int {
	if duration <= 0 || bytes <= 0 {
		return 0
	}
	return int(bytes * 8 * int64(time.Second) / int64(duration))
}

// durationFromSamples converts a sample count at the given rate to a
// time.Duration without overflowing int64 on multi-day streams.
func durationFromSamples[T ~int32 | ~int64 | ~uint32 | ~uint64](samples T, sampleRate int) time.Duration {
	if samples <= 0 || sampleRate <= 0 {
		return 0
	}
	s := uint64(samples)
	secs := s / uint64(sampleRate)
	rem := s % uint64(sampleRate)
	return time.Duration(secs)*time.Second + time.Duration(rem)*time.Second/time.Duration(sampleRate)
}

// AudioProperties decodes the audio-stream parameters the current
// container exposes. Results are cached on the [File]; subsequent
// calls return the same value without re-reading the source.
//
// Coverage varies by format:
//   - FLAC, WAV, AIFF, DSF, DFF: read from the format's fixed
//     header (STREAMINFO, fmt, COMM, DSD header).
//   - MP4 / M4A / M4B: mvhd + mdhd + stsd chain.
//   - Ogg Vorbis / Opus / Speex / Ogg-FLAC: identification packet
//     plus stream granule positions.
//   - Matroska / WebM: Segment Info + first audio TrackEntry.
//   - MPEG audio, ADTS AAC, AC-3 / E-AC-3, DTS, and AMR: the codec's
//     first valid frame plus a sequential walk of the stream.
//   - RealMedia audio and tracker modules: container-specific headers.
//
// Fields not applicable to a codec (e.g. bit depth on a lossy
// format) stay zero. A `Codec` tag like "mp3", "flac", "vorbis",
// "opus", "aac", "pcm", etc. is always populated when the parser
// could identify the stream.
func (f *File) AudioProperties() AudioProperties {
	if f.audioCached {
		return f.audio
	}
	f.audioCached = true
	if f.src == nil {
		return f.audio
	}
	style := f.audioPropsStyle
	switch f.container.Kind() {
	case ContainerFLAC:
		f.audio = f.readFLACAudio()
	case ContainerOGG:
		f.audio = f.readOGGAudio(style)
	case ContainerWAV:
		f.audio = f.readWAVAudio()
	case ContainerW64:
		f.audio = f.readW64Audio()
	case ContainerAIFF:
		f.audio = f.readAIFFAudio()
	case ContainerMP4:
		f.audio = f.readMP4Audio()
	case ContainerMatroska:
		f.audio = f.readMatroskaAudio()
	case ContainerMP3:
		f.audio = f.readMPEGAudio(style)
	case ContainerAAC:
		f.audio = f.readAACAudio(style)
	case ContainerAC3:
		f.audio = f.readAC3Audio()
	case ContainerDTS:
		f.audio = f.readDTSAudio()
	case ContainerAMR:
		f.audio = f.readAMRAudio()
	case ContainerMAC:
		f.audio = f.readAPEAudio()
	case ContainerWavPack:
		f.audio = f.readWavPackAudio()
	case ContainerMPC:
		f.audio = f.readMPCAudio()
	case ContainerDSF:
		f.audio = f.readDSFAudio()
	case ContainerDFF:
		f.audio = f.readDFFAudio()
	case ContainerASF:
		f.audio = f.readASFAudio()
	case ContainerTTA:
		f.audio = f.readTTAAudio()
	case ContainerTAK:
		f.audio = f.readTAKAudio()
	case ContainerCAF:
		f.audio = f.readCAFAudio()
	case ContainerOMA:
		f.audio = f.readOMAAudio()
	case ContainerRealMedia:
		f.audio = f.readRealMediaAudio()
	case ContainerMOD, ContainerS3M, ContainerXM, ContainerIT:
		f.audio = f.readTrackerAudio()
	}
	return f.audio
}

// -- FLAC ------------------------------------------------------------

func (f *File) readFLACAudio() AudioProperties {
	// STREAMINFO is the first metadata block after the fLaC magic.
	// Header layout: 4-byte magic + 4-byte block header + 34-byte
	// STREAMINFO body. Some files carry a prepended ID3v2 tag ahead of
	// the FLAC stream, so skip past any such tag before looking for the
	// FLAC magic.
	start := int64(0)
	if f.v2at > 0 || f.v2size > 0 {
		start = f.v2at + f.v2size
	} else {
		var hdr [id3v2.HeaderSize]byte
		if _, err := f.src.ReadAt(hdr[:], 0); err == nil &&
			hdr[0] == 'I' && hdr[1] == 'D' && hdr[2] == '3' {
			if h, err := id3v2.ReadHeader(hdr[:]); err == nil {
				start = int64(id3v2.HeaderSize) + int64(h.Size)
				if h.Major == 4 && h.Flags&0x10 != 0 {
					start += int64(id3v2.HeaderSize)
				}
			}
		}
	}
	var buf [4 + 4 + 34]byte
	if _, err := f.src.ReadAt(buf[:], start); err != nil {
		return AudioProperties{}
	}
	if string(buf[0:4]) != "fLaC" {
		return AudioProperties{}
	}
	body := buf[8:42]
	// Sample rate: bits [80..100) of body, 20-bit BE
	sr := uint32(body[10])<<12 | uint32(body[11])<<4 | uint32(body[12])>>4
	ch := int((body[12]>>1)&0x07) + 1
	bd := int(((body[12]&0x01)<<4)|(body[13]>>4)) + 1
	// Total samples: bits [108..144), 36-bit BE
	ts := (uint64(body[13]&0x0F) << 32) | uint64(body[14])<<24 |
		uint64(body[15])<<16 | uint64(body[16])<<8 | uint64(body[17])
	out := AudioProperties{
		SampleRate: int(sr),
		Channels:   ch,
		BitDepth:   bd,
		Codec:      "flac",
	}
	if sr > 0 && ts > 0 {
		out.Duration = time.Duration(ts) * time.Second / time.Duration(sr)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- WAV -------------------------------------------------------------

func (f *File) readWAVAudio() AudioProperties {
	// Walk chunks looking for fmt, fact, and data.
	order := binary.LittleEndian
	var fmtAt, fmtSize, factAt, factSize, dataSize int64 = -1, 0, -1, 0, 0
	for _, c := range listIFFChunks(f.src, f.size, order, f.container.info().outerMagic) {
		switch string(c.ID[:]) {
		case "fmt ":
			fmtAt = c.DataAt
			fmtSize = c.DataSize
		case "fact":
			factAt = c.DataAt
			factSize = c.DataSize
		case "data":
			dataSize = c.DataSize
		}
	}
	if fmtAt < 0 || fmtSize < 16 {
		return AudioProperties{}
	}
	body := make([]byte, fmtSize)
	if _, err := f.src.ReadAt(body, fmtAt); err != nil {
		return AudioProperties{}
	}
	formatTag := order.Uint16(body[0:2])
	out := AudioProperties{
		Channels:   int(order.Uint16(body[2:4])),
		SampleRate: int(order.Uint32(body[4:8])),
		Bitrate:    int(order.Uint32(body[8:12])) * 8,
	}
	blockAlign := 0
	if fmtSize >= 14 {
		blockAlign = int(order.Uint16(body[12:14]))
	}
	if fmtSize >= 16 {
		out.BitDepth = int(order.Uint16(body[14:16]))
	}
	switch formatTag {
	case 0x0001:
		out.Codec = "pcm"
	case 0x0003:
		out.Codec = "pcm-float"
	case 0x0006:
		out.Codec = "alaw"
	case 0x0007:
		out.Codec = "ulaw"
	case 0x0055:
		out.Codec = "mp3"
	case 0x00FF, 0x1600, 0x1601:
		out.Codec = "aac"
	case 0xFFFE:
		out.Codec = "pcm-ext"
	default:
		out.Codec = "wav"
	}
	// For linear PCM formats, the data chunk's byte count divided by
	// the block alignment is always the exact sample count. The fact
	// chunk is technically required for non-PCM formats but many
	// writers emit it for PCM too, sometimes with a stale or
	// unit-mismatched value (samples vs. frames vs. blocks). Trust
	// the data/blockAlign computation for linear PCM; fall back to
	// fact only for codecs where we cannot derive samples from the
	// byte layout.
	isLinearPCM := formatTag == 0x0001 || formatTag == 0x0003 || formatTag == 0xFFFE
	var totalSamples uint64
	if isLinearPCM && blockAlign > 0 && dataSize > 0 {
		totalSamples = uint64(dataSize / int64(blockAlign))
	}
	if totalSamples == 0 && factAt >= 0 && factSize >= 4 {
		var fact [4]byte
		if _, err := f.src.ReadAt(fact[:], factAt); err == nil {
			totalSamples = uint64(order.Uint32(fact[:]))
		}
	}
	if totalSamples == 0 && blockAlign > 0 && dataSize > 0 {
		totalSamples = uint64(dataSize / int64(blockAlign))
	}
	if totalSamples > 0 && out.SampleRate > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration == 0 && out.SampleRate > 0 && out.BitDepth > 0 && out.Channels > 0 && dataSize > 0 {
		bytesPerSec := out.SampleRate * out.BitDepth / 8 * out.Channels
		if bytesPerSec > 0 {
			out.Duration = time.Duration(dataSize) * time.Second / time.Duration(bytesPerSec)
		}
	}
	return out
}

func (f *File) readW64Audio() AudioProperties {
	var fmtAt, fmtSize, factAt, factSize, dataSize int64 = -1, 0, -1, 0, 0
	for _, c := range listWave64Chunks(f.src, f.size) {
		switch c.GUID {
		case w64GUIDFmt:
			fmtAt = c.DataAt
			fmtSize = c.DataSize
		case w64GUIDFact:
			factAt = c.DataAt
			factSize = c.DataSize
		case w64GUIDData:
			dataSize = c.DataSize
		}
	}
	if fmtAt < 0 || fmtSize < 16 {
		return AudioProperties{}
	}
	body := make([]byte, fmtSize)
	if _, err := f.src.ReadAt(body, fmtAt); err != nil {
		return AudioProperties{}
	}
	formatTag := binary.LittleEndian.Uint16(body[0:2])
	out := AudioProperties{
		Channels:   int(binary.LittleEndian.Uint16(body[2:4])),
		SampleRate: int(binary.LittleEndian.Uint32(body[4:8])),
		Bitrate:    int(binary.LittleEndian.Uint32(body[8:12])) * 8,
	}
	blockAlign := 0
	if fmtSize >= 14 {
		blockAlign = int(binary.LittleEndian.Uint16(body[12:14]))
	}
	if fmtSize >= 16 {
		out.BitDepth = int(binary.LittleEndian.Uint16(body[14:16]))
	}
	switch formatTag {
	case 0x0001:
		out.Codec = "pcm"
	case 0x0003:
		out.Codec = "pcm-float"
	case 0x0006:
		out.Codec = "alaw"
	case 0x0007:
		out.Codec = "ulaw"
	case 0x0055:
		out.Codec = "mp3"
	case 0x00FF, 0x1600, 0x1601:
		out.Codec = "aac"
	case 0xFFFE:
		out.Codec = "pcm-ext"
	default:
		out.Codec = "wav"
	}
	isLinearPCM := formatTag == 0x0001 || formatTag == 0x0003 || formatTag == 0xFFFE
	var totalSamples uint64
	if isLinearPCM && blockAlign > 0 && dataSize > 0 {
		totalSamples = uint64(dataSize / int64(blockAlign))
	}
	if totalSamples == 0 && factAt >= 0 && factSize >= 8 {
		var fact [8]byte
		if _, err := f.src.ReadAt(fact[:], factAt); err == nil {
			totalSamples = binary.LittleEndian.Uint64(fact[:])
		}
	}
	if totalSamples == 0 && blockAlign > 0 && dataSize > 0 {
		totalSamples = uint64(dataSize / int64(blockAlign))
	}
	if totalSamples > 0 && out.SampleRate > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration == 0 && out.SampleRate > 0 && out.BitDepth > 0 && out.Channels > 0 && dataSize > 0 {
		bytesPerSec := out.SampleRate * out.BitDepth / 8 * out.Channels
		if bytesPerSec > 0 {
			out.Duration = time.Duration(dataSize) * time.Second / time.Duration(bytesPerSec)
		}
	}
	return out
}

// -- AIFF / AIFC ------------------------------------------------------

func (f *File) readAIFFAudio() AudioProperties {
	order := binary.BigEndian
	var commAt, commSize, ssndSize int64 = -1, 0, 0
	for _, c := range listIFFChunks(f.src, f.size, order, f.container.info().outerMagic) {
		switch string(c.ID[:]) {
		case "COMM":
			commAt = c.DataAt
			commSize = c.DataSize
		case "SSND":
			ssndSize = c.DataSize
		}
	}
	if commAt < 0 || commSize < 18 {
		return AudioProperties{}
	}
	body := make([]byte, commSize)
	if _, err := f.src.ReadAt(body, commAt); err != nil {
		return AudioProperties{}
	}
	ch := int(order.Uint16(body[0:2]))
	frames := uint32(order.Uint32(body[2:6]))
	bd := int(order.Uint16(body[6:8]))
	// 10-byte 80-bit IEEE extended sample rate. Only the integer part is
	// needed here.
	sr := ieee80ToInt(body[8:18])
	out := AudioProperties{
		Channels:   ch,
		BitDepth:   bd,
		SampleRate: sr,
		Codec:      "pcm",
	}
	if commSize >= 23 {
		switch string(body[18:22]) {
		case "NONE", "twos", "sowt", "raw ", "in24", "in32":
			out.Codec = "pcm"
		case "fl32", "FL32", "fl64", "FL64":
			out.Codec = "pcm-float"
		case "ALAW":
			out.Codec = "alaw"
		case "ulaw", "ULAW":
			out.Codec = "ulaw"
		default:
			out.Codec = strings.TrimSpace(string(body[18:22]))
		}
	}
	if sr > 0 && frames > 0 {
		out.Duration = time.Duration(frames) * time.Second / time.Duration(sr)
	}
	if out.Duration > 0 {
		audioBytes := ssndSize
		if audioBytes > 8 {
			audioBytes -= 8 // offset + block-size fields
		} else {
			audioBytes = f.size
		}
		out.Bitrate = bitrateBps(audioBytes, out.Duration)
	}
	return out
}

// ieee80ToInt decodes the integer part of an 80-bit IEEE extended
// float. Plenty for sample rate values.
func ieee80ToInt(b []byte) int {
	if len(b) < 10 {
		return 0
	}
	exp := int(binary.BigEndian.Uint16(b[0:2])&0x7FFF) - 16383
	mant := binary.BigEndian.Uint64(b[2:10])
	if exp < 0 || exp > 63 {
		return 0
	}
	return int(mant >> (63 - exp))
}

// -- MP4 -------------------------------------------------------------

func (f *File) readMP4Audio() AudioProperties {
	// Walk moov -> mvhd (duration + timescale) and the first trak with
	// an audio handler -> mdia/mdhd (per-track timescale / duration) ->
	// mdia/minf/stbl/stsd (codec sample entry).
	moov, ok := findTopAtom(f.src, f.size, "moov")
	if !ok {
		return AudioProperties{}
	}
	out := AudioProperties{}
	if box, ok := findChildAtom(f.src, moov, "mvhd"); ok {
		var hdr [32]byte
		if _, err := f.src.ReadAt(hdr[:], box.dataAt); err == nil {
			ver := hdr[0]
			if ver == 0 {
				ts := binary.BigEndian.Uint32(hdr[12:16])
				dur := binary.BigEndian.Uint32(hdr[16:20])
				if ts > 0 {
					out.Duration = time.Duration(dur) * time.Second / time.Duration(ts)
				}
			} else {
				if box.dataSize < 36 {
					return out
				}
				var hdr2 [36]byte
				if _, err := f.src.ReadAt(hdr2[:], box.dataAt); err == nil {
					ts := binary.BigEndian.Uint32(hdr2[20:24])
					dur := binary.BigEndian.Uint64(hdr2[24:32])
					if ts > 0 {
						out.Duration = time.Duration(dur) * time.Second / time.Duration(ts)
					}
				}
			}
		}
	}
	// Find audio trak.
	for _, trak := range findAllChildAtoms(f.src, moov, "trak") {
		mdia, ok := findChildAtom(f.src, trak, "mdia")
		if !ok {
			continue
		}
		hdlr, ok := findChildAtom(f.src, mdia, "hdlr")
		if !ok {
			continue
		}
		var hdlrBuf [24]byte
		if _, err := f.src.ReadAt(hdlrBuf[:], hdlr.dataAt); err != nil || string(hdlrBuf[8:12]) != "soun" {
			continue
		}
		minf, ok := findChildAtom(f.src, mdia, "minf")
		if !ok {
			continue
		}
		stbl, ok := findChildAtom(f.src, minf, "stbl")
		if !ok {
			continue
		}
		stsd, ok := findChildAtom(f.src, stbl, "stsd")
		if !ok {
			continue
		}
		// stsd body layout:
		//   [0:4]  version + flags
		//   [4:8]  entry_count
		//   entry:
		//     [8:12]  size (32-bit BE)
		//     [12:16] format FourCC
		//     [16:22] reserved (6 bytes), SampleEntry
		//     [22:24] data_reference_index
		//     [24:32] reserved (8 bytes), AudioSampleEntry lead-in
		//     [32:34] channel_count
		//     [34:36] sample_size (bit depth)
		//     [36:38] pre_defined
		//     [38:40] reserved
		//     [40:44] sample_rate (16.16 fixed point)
		var sd [44]byte
		if _, err := f.src.ReadAt(sd[:], stsd.dataAt); err != nil {
			continue
		}
		codec := string(sd[12:16])
		switch codec {
		case "mp4a":
			out.Codec = "aac"
		case "alac":
			out.Codec = "alac"
		case "Opus":
			out.Codec = "opus"
		case "flac":
			out.Codec = "flac"
		default:
			out.Codec = codec
		}
		out.Channels = int(binary.BigEndian.Uint16(sd[32:34]))
		out.BitDepth = int(binary.BigEndian.Uint16(sd[34:36]))
		out.SampleRate = int(binary.BigEndian.Uint32(sd[40:44]) >> 16)
		break
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// atomLoc is a narrow local view for the MP4 walker used here;
// we avoid pulling the mp4 package's internal type into the
// public surface.
type atomLoc struct {
	offset   int64
	dataAt   int64
	dataSize int64
}

func findTopAtom(r io.ReaderAt, size int64, name string) (atomLoc, bool) {
	off := int64(0)
	for off+8 <= size {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return atomLoc{}, false
		}
		atomSize := int64(binary.BigEndian.Uint32(hdr[0:4]))
		headerLen := int64(8)
		if atomSize == 1 {
			var ext [8]byte
			if _, err := r.ReadAt(ext[:], off+8); err != nil {
				return atomLoc{}, false
			}
			atomSize = int64(binary.BigEndian.Uint64(ext[:]))
			headerLen = 16
		} else if atomSize == 0 {
			atomSize = size - off
		}
		if atomSize < headerLen {
			return atomLoc{}, false
		}
		// Some files declare an atom size that runs past the available
		// bytes. Clamp the size to the readable range and keep walking as
		// long as the header itself is present.
		if off+atomSize > size {
			atomSize = size - off
			if atomSize < headerLen {
				return atomLoc{}, false
			}
		}
		if string(hdr[4:8]) == name {
			return atomLoc{offset: off, dataAt: off + headerLen, dataSize: atomSize - headerLen}, true
		}
		off += atomSize
	}
	return atomLoc{}, false
}

func findChildAtom(r io.ReaderAt, parent atomLoc, name string) (atomLoc, bool) {
	end := parent.dataAt + parent.dataSize
	off := parent.dataAt
	for off+8 <= end {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return atomLoc{}, false
		}
		atomSize := int64(binary.BigEndian.Uint32(hdr[0:4]))
		headerLen := int64(8)
		if atomSize == 1 {
			var ext [8]byte
			if _, err := r.ReadAt(ext[:], off+8); err != nil {
				return atomLoc{}, false
			}
			atomSize = int64(binary.BigEndian.Uint64(ext[:]))
			headerLen = 16
		} else if atomSize == 0 {
			atomSize = end - off
		}
		if atomSize < headerLen {
			return atomLoc{}, false
		}
		if off+atomSize > end {
			atomSize = end - off
			if atomSize < headerLen {
				return atomLoc{}, false
			}
		}
		if string(hdr[4:8]) == name {
			return atomLoc{offset: off, dataAt: off + headerLen, dataSize: atomSize - headerLen}, true
		}
		off += atomSize
	}
	return atomLoc{}, false
}

func findAllChildAtoms(r io.ReaderAt, parent atomLoc, name string) []atomLoc {
	var out []atomLoc
	end := parent.dataAt + parent.dataSize
	off := parent.dataAt
	for off+8 <= end {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return out
		}
		atomSize := int64(binary.BigEndian.Uint32(hdr[0:4]))
		headerLen := int64(8)
		if atomSize == 1 {
			var ext [8]byte
			if _, err := r.ReadAt(ext[:], off+8); err != nil {
				return out
			}
			atomSize = int64(binary.BigEndian.Uint64(ext[:]))
			headerLen = 16
		} else if atomSize == 0 {
			atomSize = end - off
		}
		if atomSize < headerLen {
			return out
		}
		if off+atomSize > end {
			atomSize = end - off
			if atomSize < headerLen {
				return out
			}
		}
		if string(hdr[4:8]) == name {
			out = append(out, atomLoc{offset: off, dataAt: off + headerLen, dataSize: atomSize - headerLen})
		}
		off += atomSize
	}
	return out
}

// -- OGG -------------------------------------------------------------

func (f *File) readOGGAudio(style AudioPropertiesStyle) AudioProperties {
	serial, packets, err := readOGGAudioPackets(f.src, f.size, 2)
	if err != nil || len(packets) == 0 {
		return AudioProperties{}
	}
	ident := packets[0]
	out := AudioProperties{}
	switch {
	case len(ident) >= 28 && ident[0] == 0x01 && string(ident[1:7]) == "vorbis":
		out.Codec = "vorbis"
		out.Channels = int(ident[11])
		out.SampleRate = int(binary.LittleEndian.Uint32(ident[12:16]))
		// Vorbis stores the nominal bitrate as an int32 where
		// values of 0 or -1 (stored as 0xFFFFFFFF) both mean
		// "unknown". Report 0 in either case so callers can tell
		// the bitrate wasn't declared.
		if nom := int32(binary.LittleEndian.Uint32(ident[20:24])); nom > 0 {
			out.Bitrate = int(nom)
		}
	case len(ident) >= 19 && string(ident[0:8]) == "OpusHead":
		out.Codec = "opus"
		out.Channels = int(ident[9])
		out.SampleRate = 48000
	case len(ident) >= 56 && string(ident[0:8]) == "Speex   ":
		out.Codec = "speex"
		out.SampleRate = int(binary.LittleEndian.Uint32(ident[36:40]))
		out.Channels = int(binary.LittleEndian.Uint32(ident[48:52]))
		// Speex bitrate field is a signed int32; -1 signals
		// "unknown". Guard the same way as Vorbis.
		if br := int32(binary.LittleEndian.Uint32(ident[52:56])); br > 0 {
			out.Bitrate = int(br)
		}
	case len(ident) >= 51 && ident[0] == 0x7F && string(ident[1:5]) == "FLAC":
		out.Codec = "flac"
		body := ident[9+4+4:]
		if len(body) >= 18 {
			sr := uint32(body[10])<<12 | uint32(body[11])<<4 | uint32(body[12])>>4
			out.SampleRate = int(sr)
			out.Channels = int((body[12]>>1)&0x07) + 1
			out.BitDepth = int(((body[12]&0x01)<<4)|(body[13]>>4)) + 1
		}
	case len(ident) >= 4 && string(ident[0:4]) == "fLaC" && len(packets) >= 2 && len(packets[1]) >= 38:
		out.Codec = "flac"
		body := packets[1][4:38]
		sr := uint32(body[10])<<12 | uint32(body[11])<<4 | uint32(body[12])>>4
		out.SampleRate = int(sr)
		out.Channels = int((body[12]>>1)&0x07) + 1
		out.BitDepth = int(((body[12]&0x01)<<4)|(body[13]>>4)) + 1
	}
	if out.Codec == "" {
		return out
	}
	if style == AudioPropertiesFast {
		return out
	}
	lastGranule := int64(-1)
	for off := int64(0); off < f.size; {
		p, err := readOGGAudioPage(f.src, off, f.size)
		if err != nil {
			break
		}
		if p.serial == serial && p.granulePos >= 0 {
			lastGranule = p.granulePos
		}
		off += p.pageLen
	}
	if out.SampleRate > 0 && lastGranule > 0 {
		samples := lastGranule
		if samples > 0 {
			out.Duration = durationFromSamples(samples, out.SampleRate)
		}
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

type oggAudioPage struct {
	serial     uint32
	granulePos int64
	flags      byte
	segments   []byte
	bodyAt     int64
	pageLen    int64
}

func readOGGAudioPage(r io.ReaderAt, offset, size int64) (oggAudioPage, error) {
	var hdr [27]byte
	if offset+int64(len(hdr)) > size {
		return oggAudioPage{}, io.ErrUnexpectedEOF
	}
	if _, err := r.ReadAt(hdr[:], offset); err != nil {
		return oggAudioPage{}, err
	}
	if string(hdr[0:4]) != "OggS" {
		return oggAudioPage{}, io.ErrUnexpectedEOF
	}
	segCount := int(hdr[26])
	if offset+27+int64(segCount) > size {
		return oggAudioPage{}, io.ErrUnexpectedEOF
	}
	segments := make([]byte, segCount)
	if segCount > 0 {
		if _, err := r.ReadAt(segments, offset+27); err != nil {
			return oggAudioPage{}, err
		}
	}
	bodyLen := int64(0)
	for _, seg := range segments {
		bodyLen += int64(seg)
	}
	pageLen := int64(27 + segCount)
	pageLen += bodyLen
	granule := int64(binary.LittleEndian.Uint64(hdr[6:14]))
	return oggAudioPage{
		serial:     binary.LittleEndian.Uint32(hdr[14:18]),
		granulePos: granule,
		flags:      hdr[5],
		segments:   segments,
		bodyAt:     offset + int64(27+segCount),
		pageLen:    pageLen,
	}, nil
}

func readOGGAudioPackets(r io.ReaderAt, size int64, maxPackets int) (uint32, [][]byte, error) {
	first, err := readOGGAudioPage(r, 0, size)
	if err != nil {
		return 0, nil, err
	}
	serial := first.serial
	var packets [][]byte
	var pending []byte
	for off := int64(0); off < size && len(packets) < maxPackets; {
		page, err := readOGGAudioPage(r, off, size)
		if err != nil {
			break
		}
		off += page.pageLen
		if page.serial != serial {
			continue
		}
		bodyLen := 0
		for _, seg := range page.segments {
			bodyLen += int(seg)
		}
		body := make([]byte, bodyLen)
		if bodyLen > 0 {
			if _, err := r.ReadAt(body, page.bodyAt); err != nil {
				return serial, packets, err
			}
		}
		pos := 0
		start := 0
		continued := page.flags&0x01 != 0
		for _, seg := range page.segments {
			pos += int(seg)
			if seg == 255 {
				continue
			}
			chunk := append([]byte(nil), body[start:pos]...)
			if continued {
				if pending != nil {
					pending = append(pending, chunk...)
					packets = append(packets, pending)
					pending = nil
				}
				continued = false
			} else if pending != nil {
				pending = append(pending, chunk...)
				packets = append(packets, pending)
				pending = nil
			} else {
				packets = append(packets, chunk)
			}
			start = pos
			if len(packets) >= maxPackets {
				break
			}
		}
		if start < len(body) {
			pending = append(pending, body[start:]...)
		}
	}
	return serial, packets, nil
}

// -- Matroska --------------------------------------------------------

func (f *File) readMatroskaAudio() AudioProperties {
	out := AudioProperties{}
	// Walk Segment -> Info (TimecodeScale + Duration) and the first
	// Tracks -> TrackEntry with audio TrackType.
	headID, headIDLen, _, err := readEBMLVintAt(f.src, 0, true)
	if err != nil || headID != ebmlIDHeader {
		return out
	}
	headSize, headSizeLen, _, err := readEBMLVintAt(f.src, int64(headIDLen), false)
	if err != nil {
		return out
	}
	segOff := int64(headIDLen + headSizeLen + int(headSize))
	segID, segIDLen, _, err := readEBMLVintAt(f.src, segOff, true)
	if err != nil || segID != ebmlIDSegment {
		return out
	}
	segSize, segSizeLen, segUnknown, err := readEBMLVintAt(f.src, segOff+int64(segIDLen), false)
	if err != nil {
		return out
	}
	segDataAt := segOff + int64(segIDLen+segSizeLen)
	segEnd := f.size
	if !segUnknown {
		segEnd = segDataAt + int64(segSize)
	}
	off := segDataAt
	var timecodeScale uint64 = 1000000 // default 1ms
	var durationTicks float64
	for off < segEnd {
		id, idLen, _, err := readEBMLVintAt(f.src, off, true)
		if err != nil {
			break
		}
		sz, szLen, unknown, err := readEBMLVintAt(f.src, off+int64(idLen), false)
		if err != nil || unknown {
			break
		}
		dataAt := off + int64(idLen+szLen)
		dataEnd := dataAt + int64(sz)
		if dataEnd > segEnd {
			break
		}
		switch id {
		case ebmlIDInfo:
			ts, dur := parseMatroskaInfoHeader(f.src, dataAt, dataEnd)
			if ts > 0 {
				timecodeScale = ts
			}
			if dur > 0 {
				durationTicks = dur
			}
		case 0x1654AE6B: // Tracks
			if codec, ch, sr, bd := parseFirstAudioTrack(f.src, dataAt, dataEnd); codec != "" {
				out.Codec = normaliseMatroskaCodec(codec)
				out.Channels = ch
				out.SampleRate = sr
				out.BitDepth = bd
			}
		}
		off = dataEnd
	}
	if durationTicks > 0 && timecodeScale > 0 {
		ns := durationTicks * float64(timecodeScale)
		out.Duration = time.Duration(ns)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

func parseMatroskaInfoHeader(r io.ReaderAt, start, end int64) (timecodeScale uint64, durationTicks float64) {
	body := make([]byte, end-start)
	if _, err := r.ReadAt(body, start); err != nil {
		return 0, 0
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sz, szLen, _, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok {
			return
		}
		dataAt := off + idLen + szLen
		dataEnd := dataAt + int(sz)
		if dataEnd > len(body) {
			return
		}
		switch id {
		case 0x2AD7B1: // TimecodeScale
			if v, ok := parseEBMLInt(body[dataAt:dataEnd]); ok {
				timecodeScale = uint64(v)
			}
		case 0x4489: // Duration (float)
			if sz == 4 {
				bits := binary.BigEndian.Uint32(body[dataAt:dataEnd])
				durationTicks = float64(float32frombits(bits))
			} else if sz == 8 {
				bits := binary.BigEndian.Uint64(body[dataAt:dataEnd])
				durationTicks = float64frombits(bits)
			}
		}
		off = dataEnd
	}
	return
}

func parseFirstAudioTrack(r io.ReaderAt, start, end int64) (codec string, channels, sampleRate, bitDepth int) {
	body := make([]byte, end-start)
	if _, err := r.ReadAt(body, start); err != nil {
		return
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sz, szLen, _, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok {
			return
		}
		dataAt := off + idLen + szLen
		dataEnd := dataAt + int(sz)
		if dataEnd > len(body) {
			return
		}
		if id == 0xAE { // TrackEntry
			if tCodec, tCh, tSr, tBd := parseTrackEntry(body[dataAt:dataEnd]); tCodec != "" {
				return tCodec, tCh, tSr, tBd
			}
		}
		off = dataEnd
	}
	return
}

func parseTrackEntry(body []byte) (codec string, channels, sampleRate, bitDepth int) {
	var trackType int
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sz, szLen, _, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok {
			return
		}
		dataAt := off + idLen + szLen
		dataEnd := dataAt + int(sz)
		if dataEnd > len(body) {
			return
		}
		switch id {
		case 0x83: // TrackType
			if v, ok := parseEBMLInt(body[dataAt:dataEnd]); ok {
				trackType = int(v)
			}
		case 0x86: // CodecID
			codec = string(body[dataAt:dataEnd])
		case 0xE1: // Audio
			channels, sampleRate, bitDepth = parseAudioElement(body[dataAt:dataEnd])
		}
		off = dataEnd
	}
	if trackType != 2 {
		return "", 0, 0, 0
	}
	return
}

// normaliseMatroskaCodec converts the CodecID string from the
// Matroska registry to the short names [AudioProperties.Codec] uses
// elsewhere in mtag. Unknown codecs are returned unchanged.
func normaliseMatroskaCodec(id string) string {
	switch id {
	case "A_VORBIS":
		return "vorbis"
	case "A_OPUS":
		return "opus"
	case "A_FLAC":
		return "flac"
	case "A_AAC", "A_AAC/MPEG2/LC", "A_AAC/MPEG4/LC", "A_AAC/MPEG4/LC/SBR":
		return "aac"
	case "A_MPEG/L3":
		return "mp3"
	case "A_MPEG/L2":
		return "mp2"
	case "A_AC3":
		return "ac3"
	case "A_DTS":
		return "dts"
	case "A_PCM/INT/LIT", "A_PCM/INT/BIG", "A_PCM/FLOAT/IEEE":
		return "pcm"
	}
	return id
}

func parseAudioElement(body []byte) (channels, sampleRate, bitDepth int) {
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sz, szLen, _, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok {
			return
		}
		dataAt := off + idLen + szLen
		dataEnd := dataAt + int(sz)
		if dataEnd > len(body) {
			return
		}
		switch id {
		case 0xB5: // SamplingFrequency (float)
			if sz == 4 {
				bits := binary.BigEndian.Uint32(body[dataAt:dataEnd])
				sampleRate = int(float32frombits(bits))
			} else if sz == 8 {
				bits := binary.BigEndian.Uint64(body[dataAt:dataEnd])
				sampleRate = int(float64frombits(bits))
			}
		case 0x9F: // Channels
			if v, ok := parseEBMLInt(body[dataAt:dataEnd]); ok {
				channels = int(v)
			}
		case 0x6264: // BitDepth
			if v, ok := parseEBMLInt(body[dataAt:dataEnd]); ok {
				bitDepth = int(v)
			}
		}
		off = dataEnd
	}
	return
}

func float32frombits(b uint32) float32 { return math.Float32frombits(b) }
func float64frombits(b uint64) float64 { return math.Float64frombits(b) }

// -- MPEG / AAC / AC-3 / DTS / AMR -----------------------------------

var mpegSampleRateTable = []int{
	44100, 48000, 32000, 0, // MPEG-1
	22050, 24000, 16000, 0, // MPEG-2
	11025, 12000, 8000, 0, // MPEG-2.5
}

var mpegBitrateTableV1L1 = []int{
	0, 32, 64, 96, 128, 160, 192, 224,
	256, 288, 320, 352, 384, 416, 448, 0,
}
var mpegBitrateTableV1L2 = []int{
	0, 32, 48, 56, 64, 80, 96, 112,
	128, 160, 192, 224, 256, 320, 384, 0,
}
var mpegBitrateTableV1L3 = []int{
	0, 32, 40, 48, 56, 64, 80, 96,
	112, 128, 160, 192, 224, 256, 320, 0,
}
var mpegBitrateTableV2L1 = []int{
	0, 32, 48, 56, 64, 80, 96, 112,
	128, 144, 160, 176, 192, 224, 256, 0,
}
var mpegBitrateTableV2L2L3 = []int{
	0, 8, 16, 24, 32, 40, 48, 56,
	64, 80, 96, 112, 128, 144, 160, 0,
}

type mpegFrameInfo struct {
	codec           string
	sampleRate      int
	channels        int
	bitrate         int
	frameLen        int
	samplesPerFrame int
}

func parseMPEGHeader(hdr []byte) (mpegFrameInfo, bool) {
	if len(hdr) < 4 || hdr[0] != 0xFF || (hdr[1]&0xE0) != 0xE0 {
		return mpegFrameInfo{}, false
	}
	versionBits := (hdr[1] >> 3) & 0x03
	layerBits := (hdr[1] >> 1) & 0x03
	if versionBits == 0x01 || layerBits == 0x00 {
		return mpegFrameInfo{}, false
	}
	bitrateIdx := (hdr[2] >> 4) & 0x0F
	sampleIdx := (hdr[2] >> 2) & 0x03
	if bitrateIdx == 0 || bitrateIdx == 0x0F || sampleIdx == 0x03 {
		return mpegFrameInfo{}, false
	}
	padding := int((hdr[2] >> 1) & 0x01)
	channels := 2
	if (hdr[3]>>6)&0x03 == 0x03 {
		channels = 1
	}
	var (
		codec           string
		bitrate         int
		sampleRate      int
		samplesPerFrame int
		frameLen        int
	)
	switch layerBits {
	case 0x03: // Layer I
		codec = "mp1"
		samplesPerFrame = 384
		if versionBits == 0x03 {
			bitrate = mpegBitrateTableV1L1[bitrateIdx] * 1000
			sampleRate = mpegSampleRateTable[sampleIdx]
		} else {
			bitrate = mpegBitrateTableV2L1[bitrateIdx] * 1000
			if versionBits == 0x02 {
				sampleRate = mpegSampleRateTable[4+sampleIdx]
			} else {
				sampleRate = mpegSampleRateTable[8+sampleIdx]
			}
		}
		if sampleRate > 0 {
			frameLen = ((12 * bitrate / sampleRate) + padding) * 4
		}
	case 0x02: // Layer II
		codec = "mp2"
		samplesPerFrame = 1152
		if versionBits == 0x03 {
			bitrate = mpegBitrateTableV1L2[bitrateIdx] * 1000
			sampleRate = mpegSampleRateTable[sampleIdx]
		} else {
			bitrate = mpegBitrateTableV2L2L3[bitrateIdx] * 1000
			if versionBits == 0x02 {
				sampleRate = mpegSampleRateTable[4+sampleIdx]
			} else {
				sampleRate = mpegSampleRateTable[8+sampleIdx]
			}
		}
		if sampleRate > 0 {
			frameLen = (144 * bitrate / sampleRate) + padding
		}
	case 0x01: // Layer III
		codec = "mp3"
		if versionBits == 0x03 {
			bitrate = mpegBitrateTableV1L3[bitrateIdx] * 1000
			sampleRate = mpegSampleRateTable[sampleIdx]
			samplesPerFrame = 1152
			if sampleRate > 0 {
				frameLen = (144 * bitrate / sampleRate) + padding
			}
		} else {
			bitrate = mpegBitrateTableV2L2L3[bitrateIdx] * 1000
			if versionBits == 0x02 {
				sampleRate = mpegSampleRateTable[4+sampleIdx]
			} else {
				sampleRate = mpegSampleRateTable[8+sampleIdx]
			}
			samplesPerFrame = 576
			if sampleRate > 0 {
				frameLen = (72 * bitrate / sampleRate) + padding
			}
		}
	}
	if frameLen <= 0 || sampleRate <= 0 || bitrate <= 0 {
		return mpegFrameInfo{}, false
	}
	return mpegFrameInfo{
		codec:           codec,
		sampleRate:      sampleRate,
		channels:        channels,
		bitrate:         bitrate,
		frameLen:        frameLen,
		samplesPerFrame: samplesPerFrame,
	}, true
}

type mpegSummaryInfo struct {
	frames uint32
	size   uint32
}

func findNextMPEGFrame(r io.ReaderAt, start, end int64) (int64, mpegFrameInfo, bool) {
	var hdr [4]byte
	for off := start; off+4 <= end; off++ {
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return 0, mpegFrameInfo{}, false
		}
		if info, ok := parseMPEGHeader(hdr[:]); ok {
			next := off + int64(info.frameLen)
			if next > end {
				continue
			}
			if next+4 <= end {
				var nextHdr [4]byte
				if _, err := r.ReadAt(nextHdr[:], next); err == nil {
					if _, ok := parseMPEGHeader(nextHdr[:]); !ok {
						continue
					}
				}
			}
			return off, info, true
		}
	}
	return 0, mpegFrameInfo{}, false
}

func parseMPEGSummary(frame []byte) (mpegSummaryInfo, bool) {
	layout, ok := locateMPEGSummary(frame)
	if ok {
		pos := layout.tagPos + 8
		var sum mpegSummaryInfo
		if layout.flags&0x01 != 0 && len(frame) >= pos+4 {
			sum.frames = binary.BigEndian.Uint32(frame[pos : pos+4])
			pos += 4
		}
		if layout.flags&0x02 != 0 && len(frame) >= pos+4 {
			sum.size = binary.BigEndian.Uint32(frame[pos : pos+4])
		}
		if sum.frames > 0 && sum.size > 0 {
			return sum, true
		}
	}
	idx := bytes.Index(frame, []byte("VBRI"))
	if idx >= 0 && len(frame) >= idx+18 {
		sum := mpegSummaryInfo{
			size:   binary.BigEndian.Uint32(frame[idx+10 : idx+14]),
			frames: binary.BigEndian.Uint32(frame[idx+14 : idx+18]),
		}
		if sum.frames > 0 && sum.size > 0 {
			return sum, true
		}
	}
	return mpegSummaryInfo{}, false
}

func scanMPEGFrames(r io.ReaderAt, start, end int64, maxFrames int) (frames int, totalBytes int64, totalSamples uint64, complete bool) {
	var hdr [4]byte
	off := start
	for off+4 <= end {
		if maxFrames > 0 && frames >= maxFrames {
			return frames, totalBytes, totalSamples, false
		}
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			break
		}
		info, ok := parseMPEGHeader(hdr[:])
		if !ok {
			break
		}
		totalBytes += int64(info.frameLen)
		totalSamples += uint64(info.samplesPerFrame)
		frames++
		off += int64(info.frameLen)
	}
	return frames, totalBytes, totalSamples, off >= end
}

func estimateMPEGFromAverage(streamBytes int64, sampleRate int, frames int, totalBytes int64, totalSamples uint64) (time.Duration, int) {
	if streamBytes <= 0 || sampleRate <= 0 || frames <= 0 || totalBytes <= 0 || totalSamples == 0 {
		return 0, 0
	}
	avgBytes := float64(totalBytes) / float64(frames)
	avgSamples := float64(totalSamples) / float64(frames)
	if avgBytes <= 0 || avgSamples <= 0 {
		return 0, 0
	}
	frameCount := float64(streamBytes) / avgBytes
	duration := time.Duration(frameCount*avgSamples*float64(time.Second)/float64(sampleRate) + 0.5)
	if duration <= 0 {
		return 0, 0
	}
	bitrate := int(float64(streamBytes*8)*float64(time.Second)/float64(duration) + 0.5)
	return duration, bitrate
}

func (f *File) readMPEGAudio(style AudioPropertiesStyle) AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	off, first, ok := findNextMPEGFrame(f.src, start, end)
	if !ok {
		return AudioProperties{}
	}
	out := AudioProperties{
		Codec:      first.codec,
		SampleRate: first.sampleRate,
		Channels:   first.channels,
	}
	streamBytes := end - off
	if first.codec == "mp3" && first.frameLen > 0 && first.frameLen <= 16384 {
		if frame, err := readRange(f.src, off, int64(first.frameLen)); err == nil {
			if sum, ok := parseMPEGSummary(frame); ok && first.sampleRate > 0 && first.samplesPerFrame > 0 {
				out.Duration = time.Duration(uint64(sum.frames)*uint64(first.samplesPerFrame)) * time.Second / time.Duration(first.sampleRate)
				if out.Duration > 0 {
					out.Bitrate = int((int64(sum.size)*8*int64(time.Second) + int64(out.Duration)/2) / int64(out.Duration))
				}
				return out
			}
		}
	}
	if style == AudioPropertiesFast {
		out.Bitrate = first.bitrate
		return out
	}
	maxFrames := 0
	if style == AudioPropertiesAverage {
		maxFrames = 64
	}
	frames, totalBytes, totalSamples, complete := scanMPEGFrames(f.src, off, end, maxFrames)
	if first.sampleRate > 0 && totalSamples > 0 {
		if complete {
			out.Duration = durationFromSamples(totalSamples, first.sampleRate)
			if out.Duration > 0 && totalBytes > 0 {
				out.Bitrate = bitrateBps(totalBytes, out.Duration)
			}
			return out
		}
		if style == AudioPropertiesAverage {
			out.Duration, out.Bitrate = estimateMPEGFromAverage(streamBytes, first.sampleRate, frames, totalBytes, totalSamples)
			if out.Bitrate == 0 {
				out.Bitrate = first.bitrate
			}
			return out
		}
	}
	out.Bitrate = first.bitrate
	return out
}

var adtsSampleRates = []int{
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
}

type adtsFrameInfo struct {
	sampleRate      int
	channels        int
	frameLen        int
	samplesPerFrame int
}

func parseADTSHeader(hdr []byte) (adtsFrameInfo, bool) {
	if len(hdr) < 7 || hdr[0] != 0xFF || (hdr[1]&0xF0) != 0xF0 || (hdr[1]&0x06) != 0 {
		return adtsFrameInfo{}, false
	}
	srIdx := int((hdr[2] >> 2) & 0x0F)
	if srIdx >= len(adtsSampleRates) {
		return adtsFrameInfo{}, false
	}
	frameLen := (int(hdr[3]&0x03) << 11) | (int(hdr[4]) << 3) | int(hdr[5]>>5)
	if frameLen < 7 {
		return adtsFrameInfo{}, false
	}
	channels := int((hdr[2]&0x01)<<2 | (hdr[3] >> 6))
	samplesPerFrame := 1024 * (1 + int(hdr[6]&0x03))
	return adtsFrameInfo{
		sampleRate:      adtsSampleRates[srIdx],
		channels:        channels,
		frameLen:        frameLen,
		samplesPerFrame: samplesPerFrame,
	}, true
}

func findNextADTSFrame(r io.ReaderAt, start, end int64) (int64, adtsFrameInfo, bool) {
	var hdr [7]byte
	for off := start; off+7 <= end; off++ {
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return 0, adtsFrameInfo{}, false
		}
		if info, ok := parseADTSHeader(hdr[:]); ok {
			return off, info, true
		}
	}
	return 0, adtsFrameInfo{}, false
}

func scanADTSFrames(r io.ReaderAt, start, end int64, maxFrames int) (frames int, totalBytes int64, totalSamples uint64, complete bool) {
	off := start
	var hdr [7]byte
	for off+7 <= end {
		if maxFrames > 0 && frames >= maxFrames {
			return frames, totalBytes, totalSamples, false
		}
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			break
		}
		info, ok := parseADTSHeader(hdr[:])
		if !ok {
			next, parsed, found := findNextADTSFrame(r, off+1, minInt64(end, off+4096))
			if !found {
				break
			}
			off = next
			info = parsed
		}
		totalBytes += int64(info.frameLen)
		totalSamples += uint64(info.samplesPerFrame)
		frames++
		off += int64(info.frameLen)
	}
	return frames, totalBytes, totalSamples, off >= end
}

func (f *File) readAACAudio(style AudioPropertiesStyle) AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	off, first, ok := findNextADTSFrame(f.src, start, end)
	if !ok {
		return AudioProperties{Codec: "aac"}
	}
	out := AudioProperties{
		Codec:      "aac",
		SampleRate: first.sampleRate,
		Channels:   first.channels,
	}
	if style == AudioPropertiesFast {
		return out
	}
	maxFrames := 0
	if style == AudioPropertiesAverage {
		maxFrames = 96
	}
	frames, totalBytes, totalSamples, complete := scanADTSFrames(f.src, off, end, maxFrames)
	if out.SampleRate > 0 && totalSamples > 0 {
		if complete {
			out.Duration = durationFromSamples(totalSamples, out.SampleRate)
			if out.Duration > 0 && totalBytes > 0 {
				out.Bitrate = bitrateBps(totalBytes, out.Duration)
			}
			return out
		}
		if style == AudioPropertiesAverage {
			out.Duration, out.Bitrate = estimateMPEGFromAverage(end-off, out.SampleRate, frames, totalBytes, totalSamples)
		}
	}
	return out
}

type bitReader struct {
	data []byte
	bit  int
}

func (b *bitReader) read(n int) (uint32, bool) {
	if n <= 0 || b.bit+n > len(b.data)*8 {
		return 0, false
	}
	var out uint32
	for i := 0; i < n; i++ {
		byteIdx := (b.bit + i) / 8
		shift := 7 - ((b.bit + i) % 8)
		out = (out << 1) | uint32((b.data[byteIdx]>>shift)&0x01)
	}
	b.bit += n
	return out, true
}

type bitReaderLE struct {
	data []byte
	bit  int
}

func (b *bitReaderLE) read(n int) (uint64, bool) {
	if n <= 0 || b.bit+n > len(b.data)*8 {
		return 0, false
	}
	var out uint64
	for i := 0; i < n; i++ {
		byteIdx := (b.bit + i) / 8
		shift := (b.bit + i) % 8
		out |= uint64((b.data[byteIdx]>>shift)&0x01) << i
	}
	b.bit += n
	return out, true
}

var ac3FrameSizeTable = [38][3]int{
	{64, 69, 96}, {64, 70, 96},
	{80, 87, 120}, {80, 88, 120},
	{96, 104, 144}, {96, 105, 144},
	{112, 121, 168}, {112, 122, 168},
	{128, 139, 192}, {128, 140, 192},
	{160, 174, 240}, {160, 175, 240},
	{192, 208, 288}, {192, 209, 288},
	{224, 243, 336}, {224, 244, 336},
	{256, 278, 384}, {256, 279, 384},
	{320, 348, 480}, {320, 349, 480},
	{384, 417, 576}, {384, 418, 576},
	{448, 487, 672}, {448, 488, 672},
	{512, 557, 768}, {512, 558, 768},
	{640, 696, 960}, {640, 697, 960},
	{768, 835, 1152}, {768, 836, 1152},
	{896, 975, 1344}, {896, 976, 1344},
	{1024, 1114, 1536}, {1024, 1115, 1536},
	{1152, 1253, 1728}, {1152, 1254, 1728},
	{1280, 1393, 1920}, {1280, 1394, 1920},
}
var ac3SampleRates = []int{48000, 44100, 32000}
var ac3HalfSampleRates = []int{24000, 22050, 16000}
var ac3ChannelCounts = []int{2, 1, 2, 3, 3, 4, 4, 5}

type ac3FrameInfo struct {
	codec           string
	sampleRate      int
	channels        int
	frameLen        int
	samplesPerFrame int
}

func parseAC3Header(hdr []byte) (ac3FrameInfo, bool) {
	if len(hdr) < 16 || hdr[0] != 0x0B || hdr[1] != 0x77 {
		return ac3FrameInfo{}, false
	}
	bsidGuess := int((hdr[5] >> 3) & 0x1F)
	if bsidGuess <= 10 {
		fscod := int(hdr[4] >> 6)
		frmsizecod := int(hdr[4] & 0x3F)
		if fscod >= len(ac3SampleRates) || frmsizecod >= len(ac3FrameSizeTable) {
			return ac3FrameInfo{}, false
		}
		br := bitReader{data: hdr[4:]}
		br.read(2)
		br.read(6)
		br.read(5)
		br.read(3)
		acmodBits, ok := br.read(3)
		if !ok {
			return ac3FrameInfo{}, false
		}
		acmod := int(acmodBits)
		if acmod&0x01 != 0 && acmod != 0x01 {
			br.read(2)
		}
		if acmod&0x04 != 0 {
			br.read(2)
		}
		if acmod == 0x02 {
			br.read(2)
		}
		lfeBits, ok := br.read(1)
		if !ok {
			return ac3FrameInfo{}, false
		}
		return ac3FrameInfo{
			codec:           "ac3",
			sampleRate:      ac3SampleRates[fscod],
			channels:        ac3ChannelCounts[acmod] + int(lfeBits),
			frameLen:        ac3FrameSizeTable[frmsizecod][fscod] * 2,
			samplesPerFrame: 1536,
		}, true
	}
	br := bitReader{data: hdr[2:]}
	br.read(2) // strmtype
	br.read(3) // substreamid
	frameSizeBits, ok := br.read(11)
	if !ok {
		return ac3FrameInfo{}, false
	}
	fscodBits, ok := br.read(2)
	if !ok {
		return ac3FrameInfo{}, false
	}
	fscod := int(fscodBits)
	sampleRate := 0
	blocks := 0
	if fscod == 3 {
		fscod2, ok := br.read(2)
		if !ok || int(fscod2) >= len(ac3HalfSampleRates) {
			return ac3FrameInfo{}, false
		}
		sampleRate = ac3HalfSampleRates[fscod2]
		blocks = 6
	} else {
		numBlocksCode, ok := br.read(2)
		if !ok || fscod >= len(ac3SampleRates) {
			return ac3FrameInfo{}, false
		}
		sampleRate = ac3SampleRates[fscod]
		blocks = []int{1, 2, 3, 6}[numBlocksCode]
	}
	acmodBits, ok := br.read(3)
	if !ok {
		return ac3FrameInfo{}, false
	}
	lfeBits, ok := br.read(1)
	if !ok {
		return ac3FrameInfo{}, false
	}
	acmod := int(acmodBits)
	return ac3FrameInfo{
		codec:           "eac3",
		sampleRate:      sampleRate,
		channels:        ac3ChannelCounts[acmod] + int(lfeBits),
		frameLen:        int(frameSizeBits+1) * 2,
		samplesPerFrame: blocks * 256,
	}, true
}

func findNextAC3Frame(r io.ReaderAt, start, end int64) (int64, ac3FrameInfo, bool) {
	var hdr [16]byte
	for off := start; off+int64(len(hdr)) <= end; off++ {
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return 0, ac3FrameInfo{}, false
		}
		if info, ok := parseAC3Header(hdr[:]); ok {
			return off, info, true
		}
	}
	return 0, ac3FrameInfo{}, false
}

func (f *File) readAC3Audio() AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	off, first, ok := findNextAC3Frame(f.src, start, end)
	if !ok {
		return AudioProperties{Codec: "ac3"}
	}
	out := AudioProperties{
		Codec:      first.codec,
		SampleRate: first.sampleRate,
		Channels:   first.channels,
	}
	var totalBytes int64
	var totalSamples uint64
	var hdr [16]byte
	for off+int64(len(hdr)) <= end {
		if _, err := f.src.ReadAt(hdr[:], off); err != nil {
			break
		}
		info, ok := parseAC3Header(hdr[:])
		if !ok {
			next, parsed, found := findNextAC3Frame(f.src, off+1, minInt64(end, off+4096))
			if !found {
				break
			}
			off = next
			info = parsed
		}
		totalBytes += int64(info.frameLen)
		totalSamples += uint64(info.samplesPerFrame)
		off += int64(info.frameLen)
	}
	if out.SampleRate > 0 && totalSamples > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration > 0 && totalBytes > 0 {
		out.Bitrate = bitrateBps(totalBytes, out.Duration)
	}
	return out
}

var dtsSampleRates = []int{
	0, 8000, 16000, 32000, 0, 0, 11025, 22050,
	44100, 0, 0, 12000, 24000, 48000, 96000, 192000,
}
var dtsBitrates = []int{
	32000, 56000, 64000, 96000, 112000, 128000, 192000, 224000,
	256000, 320000, 384000, 448000, 512000, 576000, 640000, 754500,
	960000, 1024000, 1152000, 1280000, 1344000, 1408000, 1411200, 1472000,
	1536000, 1920000, 2048000, 3072000, 3840000, 0, 0, 0,
}
var dtsChannelCounts = []int{1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 8, 8}

type dtsFrameInfo struct {
	sampleRate      int
	channels        int
	bitrate         int
	frameLen        int
	samplesPerFrame int
}

func normaliseDTSHeader(hdr []byte) ([]byte, bool) {
	if len(hdr) < 16 {
		return nil, false
	}
	switch {
	case hdr[0] == 0x7F && hdr[1] == 0xFE && hdr[2] == 0x80 && hdr[3] == 0x01:
		return hdr, true
	case hdr[0] == 0xFE && hdr[1] == 0x7F && hdr[2] == 0x01 && hdr[3] == 0x80:
		out := append([]byte(nil), hdr...)
		for i := 0; i+1 < len(out); i += 2 {
			out[i], out[i+1] = out[i+1], out[i]
		}
		return out, true
	default:
		return nil, false
	}
}

func parseDTSHeader(hdr []byte) (dtsFrameInfo, bool) {
	be, ok := normaliseDTSHeader(hdr)
	if !ok || len(be) < 12 {
		return dtsFrameInfo{}, false
	}
	amode := int(((be[7] & 0x0F) << 2) | (be[8] >> 6))
	sampleIdx := int((be[8] >> 2) & 0x0F)
	bitrateIdx := int(((be[8] & 0x03) << 3) | (be[9] >> 5))
	frameLen := (((int(be[5]) & 0x03) << 12) | (int(be[6]) << 4) | (int(be[7]) >> 4)) + 1
	samples := ((((int(be[4]) & 0x01) << 6) | ((int(be[5]) & 0xFC) >> 2)) + 1) * 32
	if sampleIdx >= len(dtsSampleRates) || frameLen <= 0 || samples <= 0 {
		return dtsFrameInfo{}, false
	}
	channels := 0
	if amode < len(dtsChannelCounts) {
		channels = dtsChannelCounts[amode]
	}
	if len(be) > 10 && ((be[10]>>1)&0x03) > 0 {
		channels++
	}
	bitrate := 0
	if bitrateIdx < len(dtsBitrates) {
		bitrate = dtsBitrates[bitrateIdx]
	}
	return dtsFrameInfo{
		sampleRate:      dtsSampleRates[sampleIdx],
		channels:        channels,
		bitrate:         bitrate,
		frameLen:        frameLen,
		samplesPerFrame: samples,
	}, true
}

func findNextDTSFrame(r io.ReaderAt, start, end int64) (int64, dtsFrameInfo, bool) {
	var hdr [16]byte
	for off := start; off+int64(len(hdr)) <= end; off++ {
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return 0, dtsFrameInfo{}, false
		}
		if info, ok := parseDTSHeader(hdr[:]); ok {
			return off, info, true
		}
	}
	return 0, dtsFrameInfo{}, false
}

func (f *File) readDTSAudio() AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	off, first, ok := findNextDTSFrame(f.src, start, end)
	if !ok {
		return AudioProperties{Codec: "dts"}
	}
	out := AudioProperties{
		Codec:      "dts",
		SampleRate: first.sampleRate,
		Channels:   first.channels,
	}
	var totalBytes int64
	var totalSamples uint64
	var hdr [16]byte
	for off+int64(len(hdr)) <= end {
		if _, err := f.src.ReadAt(hdr[:], off); err != nil {
			break
		}
		info, ok := parseDTSHeader(hdr[:])
		if !ok {
			next, parsed, found := findNextDTSFrame(f.src, off+1, minInt64(end, off+4096))
			if !found {
				break
			}
			off = next
			info = parsed
		}
		totalBytes += int64(info.frameLen)
		totalSamples += uint64(info.samplesPerFrame)
		if out.Bitrate == 0 {
			out.Bitrate = info.bitrate
		}
		off += int64(info.frameLen)
	}
	if out.SampleRate > 0 && totalSamples > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration > 0 && totalBytes > 0 {
		out.Bitrate = bitrateBps(totalBytes, out.Duration)
	}
	return out
}

var amrFrameSizesNB = []int{13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 1, 1}
var amrFrameSizesWB = []int{18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 0, 0, 0, 0, 1, 1}

func (f *File) readAMRAudio() AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	magic := []byte("#!AMR\n")
	codec := "amr"
	sampleRate := 8000
	if start+9 <= f.size {
		var head [9]byte
		if _, err := f.src.ReadAt(head[:], start); err == nil && string(head[:9]) == "#!AMR-WB\n" {
			magic = []byte("#!AMR-WB\n")
			codec = "amr-wb"
			sampleRate = 16000
		}
	}
	if start+int64(len(magic)) > f.size {
		return AudioProperties{Codec: codec}
	}
	buf := make([]byte, len(magic))
	if _, err := f.src.ReadAt(buf, start); err != nil || string(buf) != string(magic) {
		return AudioProperties{Codec: codec}
	}
	table := amrFrameSizesNB
	if codec == "amr-wb" {
		table = amrFrameSizesWB
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	out := AudioProperties{
		Codec:      codec,
		SampleRate: sampleRate,
		Channels:   1,
	}
	off := start + int64(len(magic))
	var frameCount int64
	var totalBytes int64
	var hdr [1]byte
	for off < end {
		if _, err := f.src.ReadAt(hdr[:], off); err != nil {
			break
		}
		frameType := int((hdr[0] >> 3) & 0x0F)
		if frameType >= len(table) || table[frameType] == 0 {
			break
		}
		frameLen := table[frameType]
		if off+int64(frameLen) > end {
			break
		}
		totalBytes += int64(frameLen)
		frameCount++
		off += int64(frameLen)
	}
	if frameCount > 0 {
		out.Duration = time.Duration(frameCount*20) * time.Millisecond
	}
	if out.Duration > 0 && totalBytes > 0 {
		out.Bitrate = bitrateBps(totalBytes, out.Duration)
	}
	return out
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// v1At returns the offset where the ID3v1 footer starts, or 0 when
// no v1 footer was detected.
func (f *File) v1At() int64 {
	if f.v1 == nil {
		return 0
	}
	return f.size - 128
}

// -- APE (Monkey's Audio) --------------------------------------------

// readAPEAudio decodes the Monkey's Audio descriptor + header. The
// modern APE layout (version >= 3980) keeps the header data in a
// fixed offset past the 52-byte descriptor; older files use an
// inline header right after the "MAC " signature.
func (f *File) readAPEAudio() AudioProperties {
	var magic [8]byte
	if _, err := f.src.ReadAt(magic[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(magic[0:4]) != "MAC " {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "ape"}
	version := binary.LittleEndian.Uint16(magic[4:6])
	if version >= 3980 {
		// Descriptor (52 bytes) followed by the header.
		var desc [52]byte
		if _, err := f.src.ReadAt(desc[:], 0); err != nil {
			return out
		}
		descLen := int64(binary.LittleEndian.Uint32(desc[8:12]))
		if descLen < 52 {
			descLen = 52
		}
		var hdr [24]byte
		if _, err := f.src.ReadAt(hdr[:], descLen); err != nil {
			return out
		}
		blocksPerFrame := binary.LittleEndian.Uint32(hdr[4:8])
		finalFrameBlocks := binary.LittleEndian.Uint32(hdr[8:12])
		totalFrames := binary.LittleEndian.Uint32(hdr[12:16])
		out.BitDepth = int(binary.LittleEndian.Uint16(hdr[16:18]))
		out.Channels = int(binary.LittleEndian.Uint16(hdr[18:20]))
		out.SampleRate = int(binary.LittleEndian.Uint32(hdr[20:24]))
		if totalFrames > 0 {
			samples := uint64(totalFrames-1)*uint64(blocksPerFrame) + uint64(finalFrameBlocks)
			if out.SampleRate > 0 && samples > 0 {
				out.Duration = durationFromSamples(samples, out.SampleRate)
			}
		}
	} else {
		// Legacy layout (version < 3980) starts at offset 6 after
		// "MAC " + 2-byte version. Fields, with offsets inside the
		// post-version hdr buffer:
		//   [0..2]   compressionLevel (uint16)
		//   [2..4]   formatFlags      (uint16)
		//   [4..6]   channels         (uint16)
		//   [6..10]  sampleRate       (uint32)
		//   [10..14] headerBytes      (uint32)
		//   [14..18] terminatingBytes (uint32)
		//   [18..22] totalFrames      (uint32)
		//   [22..26] finalFrameBlocks (uint32)
		// We need 26 bytes after "MAC "+version, so 26 bytes of hdr.
		var hdr [28]byte
		if _, err := f.src.ReadAt(hdr[:], 6); err != nil {
			return out
		}
		out.Channels = int(binary.LittleEndian.Uint16(hdr[4:6]))
		out.SampleRate = int(binary.LittleEndian.Uint32(hdr[6:10]))
		totalFrames := binary.LittleEndian.Uint32(hdr[18:22])
		finalFrameBlocks := binary.LittleEndian.Uint32(hdr[22:26])
		// blocksPerFrame varies by version. 9216 is the documented default
		// used here to derive the sample count.
		blocksPerFrame := uint32(9216)
		if totalFrames > 0 && out.SampleRate > 0 {
			samples := uint64(totalFrames-1)*uint64(blocksPerFrame) + uint64(finalFrameBlocks)
			out.Duration = durationFromSamples(samples, out.SampleRate)
		}
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- WavPack ---------------------------------------------------------

// wavPackSampleRates is the lookup table for the 4-bit sample-rate
// index in the WavPack block flags word.
var wavPackSampleRates = []int{
	6000, 8000, 9600, 11025, 12000, 16000, 22050, 24000,
	32000, 44100, 48000, 64000, 88200, 96000, 192000, 0,
}

// readWavPackAudio decodes the 32-byte WavPack block header. Spec:
// http://www.wavpack.com/WavPack5FileFormat.pdf, section 3.
func (f *File) readWavPackAudio() AudioProperties {
	var hdr [32]byte
	if _, err := f.src.ReadAt(hdr[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(hdr[0:4]) != "wvpk" {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "wavpack"}
	totalSamples := binary.LittleEndian.Uint32(hdr[12:16])
	flags := binary.LittleEndian.Uint32(hdr[24:28])
	bytesPerSample := int(flags&0x03) + 1
	out.BitDepth = bytesPerSample * 8
	if flags&0x04 != 0 {
		out.Channels = 1
	} else {
		out.Channels = 2
	}
	srIdx := int((flags >> 23) & 0x0F)
	if srIdx < len(wavPackSampleRates) {
		out.SampleRate = wavPackSampleRates[srIdx]
	}
	if totalSamples > 0 && out.SampleRate > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- Musepack (SV7 + SV8) --------------------------------------------

// mpcSampleRates is the 2-bit sample-rate index shared by SV7 and
// SV8 Musepack streams.
var mpcSampleRates = []int{44100, 48000, 37800, 32000}

func (f *File) readMPCAudio() AudioProperties {
	var head [16]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "mpc"}
	switch {
	case head[0] == 'M' && head[1] == 'P' && head[2] == 'C' && head[3] == 'K':
		readMPCSV8(f.src, f.size, &out)
		return out
	case head[0] == 'M' && head[1] == 'P' && head[2] == '+':
		readMPCSV7(head[:], f.size, &out)
	default:
		readMPCLegacy(head[:], f.size, &out)
	}
	return out
}

func readMPCSV7(head []byte, size int64, out *AudioProperties) {
	if len(head) < 16 || out == nil {
		return
	}
	out.Channels = 2
	flags := binary.LittleEndian.Uint32(head[8:12])
	srIdx := int((flags >> 16) & 0x03)
	if srIdx < len(mpcSampleRates) {
		out.SampleRate = mpcSampleRates[srIdx]
	}
	totalFrames := binary.LittleEndian.Uint32(head[4:8])
	if totalFrames == 0 {
		return
	}
	gapless := binary.LittleEndian.Uint32(head[5:9])
	samples := uint64(0)
	if (gapless>>31)&0x01 != 0 {
		lastFrameSamples := uint64((gapless >> 20) & 0x07FF)
		if uint64(totalFrames)*1152 > lastFrameSamples {
			samples = uint64(totalFrames)*1152 - lastFrameSamples
		}
	} else {
		if uint64(totalFrames)*1152 > 576 {
			samples = uint64(totalFrames)*1152 - 576
		}
	}
	if out.SampleRate > 0 && samples > 0 {
		out.Duration = durationFromSamples(samples, out.SampleRate)
	}
	if out.Duration > 0 {
		out.Bitrate = int(float64(size*8)*float64(time.Second)/float64(out.Duration) + 0.5)
	}
}

func readMPCLegacy(head []byte, size int64, out *AudioProperties) {
	if len(head) < 8 || out == nil {
		return
	}
	headerData := binary.LittleEndian.Uint32(head[0:4])
	version := int((headerData >> 11) & 0x03FF)
	if version < 4 || version > 6 {
		return
	}
	out.SampleRate = 44100
	out.Channels = 2
	out.Bitrate = int((headerData >> 23) & 0x01FF)
	var totalFrames uint32
	if version >= 5 {
		totalFrames = binary.LittleEndian.Uint32(head[4:8])
	} else {
		totalFrames = uint32(binary.LittleEndian.Uint16(head[6:8]))
	}
	if totalFrames > 0 {
		samples := uint64(totalFrames)*1152 - 576
		out.Duration = durationFromSamples(samples, out.SampleRate)
	}
	if out.Duration > 0 && out.Bitrate == 0 {
		out.Bitrate = int(float64(size*8)*float64(time.Second)/float64(out.Duration) + 0.5)
	}
}

func readMPCSV8(r io.ReaderAt, size int64, out *AudioProperties) {
	if out == nil {
		return
	}
	off := int64(4) // skip MPCK
	readSH := false
	for off+2 <= size && !readSH {
		var typ [2]byte
		if _, err := r.ReadAt(typ[:], off); err != nil {
			return
		}
		off += 2
		packetSize, sizeLen, ok := readMPCSizeAt(r, off, size)
		if !ok || packetSize < uint64(2+sizeLen) {
			return
		}
		off += int64(sizeLen)
		dataSize := int64(packetSize) - 2 - int64(sizeLen)
		if dataSize < 0 || off+dataSize > size {
			return
		}
		if string(typ[:]) == "SH" {
			buf := make([]byte, dataSize)
			if _, err := r.ReadAt(buf, off); err != nil {
				return
			}
			if len(buf) < 5 {
				return
			}
			pos := 4
			if pos >= len(buf) {
				return
			}
			pos++ // stream version
			totalSamples, ok := readMPCSizeBytes(buf, &pos)
			if !ok || pos > len(buf)-3 {
				return
			}
			beginSilence, ok := readMPCSizeBytes(buf, &pos)
			if !ok || pos > len(buf)-2 {
				return
			}
			flags := binary.BigEndian.Uint16(buf[pos : pos+2])
			srIdx := int((flags >> 13) & 0x07)
			if srIdx < len(mpcSampleRates) {
				out.SampleRate = mpcSampleRates[srIdx]
			}
			out.Channels = int((flags>>4)&0x0F) + 1
			if totalSamples > beginSilence && out.SampleRate > 0 {
				samples := totalSamples - beginSilence
				out.Duration = durationFromSamples(samples, out.SampleRate)
			}
			if out.Duration > 0 {
				out.Bitrate = int(float64(size*8)*float64(time.Second)/float64(out.Duration) + 0.5)
			}
			readSH = true
		}
		off += dataSize
	}
}

func readMPCSizeAt(r io.ReaderAt, offset, size int64) (uint64, int, bool) {
	var out uint64
	var b [1]byte
	pos := offset
	for n := 0; n < 9 && pos < size; n++ {
		if _, err := r.ReadAt(b[:], pos); err != nil {
			return 0, 0, false
		}
		out = (out << 7) | uint64(b[0]&0x7F)
		pos++
		if b[0]&0x80 == 0 {
			return out, n + 1, true
		}
	}
	return 0, 0, false
}

func readMPCSizeBytes(buf []byte, pos *int) (uint64, bool) {
	if pos == nil {
		return 0, false
	}
	var out uint64
	for n := 0; n < 9 && *pos < len(buf); n++ {
		b := buf[*pos]
		*pos++
		out = (out << 7) | uint64(b&0x7F)
		if b&0x80 == 0 {
			return out, true
		}
	}
	return 0, false
}

// -- DSF -------------------------------------------------------------

// readDSFAudio decodes the DSF header (28-byte DSD chunk +
// subsequent 52-byte fmt chunk). Reference: "DSF File Format
// Specification" v1.01, section 2.
func (f *File) readDSFAudio() AudioProperties {
	var hdr [80]byte
	if _, err := f.src.ReadAt(hdr[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(hdr[0:4]) != "DSD " {
		return AudioProperties{}
	}
	if string(hdr[28:32]) != "fmt " {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "dsd"}
	// fmt chunk body starts at offset 40 (28 DSD + 4 fmt ID + 8 size).
	out.Channels = int(binary.LittleEndian.Uint32(hdr[52:56]))
	out.SampleRate = int(binary.LittleEndian.Uint32(hdr[56:60]))
	out.BitDepth = int(binary.LittleEndian.Uint32(hdr[60:64]))
	totalSamples := binary.LittleEndian.Uint64(hdr[64:72])
	if totalSamples > 0 && out.SampleRate > 0 {
		out.Duration = durationFromSamples(totalSamples, out.SampleRate)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- DFF (DSDIFF) ----------------------------------------------------

// readDFFAudio walks the DSDIFF FRM8 container for the PROP/SND chunk
// and extracts FS (sample rate) + CHNL (channel count). Reference:
// "DSDIFF File Format Specification" v1.5, section 5.
func (f *File) readDFFAudio() AudioProperties {
	var head [16]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(head[0:4]) != "FRM8" {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "dsd"}
	const chunkHdr = 12
	cursor := int64(16)
	for cursor+chunkHdr <= f.size {
		var hdr [chunkHdr]byte
		if _, err := f.src.ReadAt(hdr[:], cursor); err != nil {
			return out
		}
		id := string(hdr[0:4])
		size := int64(binary.BigEndian.Uint64(hdr[4:12]))
		dataAt := cursor + chunkHdr
		if size < 0 || dataAt+size > f.size {
			return out
		}
		if id == "PROP" {
			// PROP contains SND + sub-chunks. Walk its body.
			propEnd := dataAt + size
			sub := dataAt + 4 // skip "SND " sub-type
			for sub+chunkHdr <= propEnd {
				var sh [chunkHdr]byte
				if _, err := f.src.ReadAt(sh[:], sub); err != nil {
					break
				}
				sid := string(sh[0:4])
				ssize := int64(binary.BigEndian.Uint64(sh[4:12]))
				sdata := sub + chunkHdr
				if ssize < 0 || sdata+ssize > propEnd {
					break
				}
				switch sid {
				case "FS  ":
					if ssize >= 4 {
						var v [4]byte
						if _, err := f.src.ReadAt(v[:], sdata); err == nil {
							out.SampleRate = int(binary.BigEndian.Uint32(v[:]))
						}
					}
				case "CHNL":
					if ssize >= 2 {
						var v [2]byte
						if _, err := f.src.ReadAt(v[:], sdata); err == nil {
							out.Channels = int(binary.BigEndian.Uint16(v[:]))
						}
					}
				}
				sub = sdata + ssize
				if ssize%2 == 1 {
					sub++
				}
			}
			return out
		}
		cursor = dataAt + size
		if size%2 == 1 {
			cursor++
		}
	}
	return out
}

// -- ASF / WMA -------------------------------------------------------

// asfFilePropertiesGUID identifies the File Properties object which
// holds the play duration across the whole ASF stream.
var asfFilePropertiesGUID = [16]byte{
	0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11,
	0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
}

// asfStreamPropertiesGUID identifies the Stream Properties object
// which carries the media-type-specific header (WAVEFORMATEX for
// audio streams).
var asfStreamPropertiesGUID = [16]byte{
	0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11,
	0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
}

// asfAudioMediaGUID identifies the stream-type for audio payloads.
var asfAudioMediaGUID = [16]byte{
	0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11,
	0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
}

// readASFAudio walks the ASF header for the File Properties and
// Stream Properties objects, pulling duration from the former and
// the WAVEFORMATEX-shaped type-specific data from the latter.
// Reference: Microsoft ASF specification revision 01.20.05, section 3.
func (f *File) readASFAudio() AudioProperties {
	var head [30]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	// Header Object GUID check.
	if head[0] != 0x30 || head[1] != 0x26 || head[2] != 0xB2 || head[3] != 0x75 {
		return AudioProperties{}
	}
	headerSize := binary.LittleEndian.Uint64(head[16:24])
	out := AudioProperties{Codec: "wma"}
	cursor := int64(30)
	end := int64(headerSize)
	for cursor+24 <= end && cursor+24 <= f.size {
		var obj [24]byte
		if _, err := f.src.ReadAt(obj[:], cursor); err != nil {
			return out
		}
		var guid [16]byte
		copy(guid[:], obj[:16])
		size := binary.LittleEndian.Uint64(obj[16:24])
		if size < 24 || cursor+int64(size) > f.size {
			return out
		}
		dataAt := cursor + 24
		switch guid {
		case asfFilePropertiesGUID:
			// 40-byte fixed payload. PlayDuration is at offset +40
			// (relative to object start) in 100ns units.
			var body [64]byte
			if _, err := f.src.ReadAt(body[:], dataAt); err == nil {
				play := binary.LittleEndian.Uint64(body[40:48])
				// Preroll is at +56..64 (ms).
				preroll := binary.LittleEndian.Uint64(body[56:64])
				ns := play * 100
				if preroll > 0 {
					prerollNs := preroll * uint64(time.Millisecond)
					if prerollNs < ns {
						ns -= prerollNs
					}
				}
				out.Duration = time.Duration(ns)
			}
		case asfStreamPropertiesGUID:
			// Stream type GUID first; if audio, type-specific data
			// begins at dataAt + 54.
			var sp [54]byte
			if _, err := f.src.ReadAt(sp[:], dataAt); err != nil {
				cursor += int64(size)
				continue
			}
			var streamType [16]byte
			copy(streamType[:], sp[0:16])
			if streamType != asfAudioMediaGUID {
				cursor += int64(size)
				continue
			}
			typeDataLen := binary.LittleEndian.Uint32(sp[40:44])
			if typeDataLen < 16 {
				cursor += int64(size)
				continue
			}
			var wfx [18]byte
			if _, err := f.src.ReadAt(wfx[:], dataAt+54); err != nil {
				cursor += int64(size)
				continue
			}
			codecID := binary.LittleEndian.Uint16(wfx[0:2])
			out.Channels = int(binary.LittleEndian.Uint16(wfx[2:4]))
			out.SampleRate = int(binary.LittleEndian.Uint32(wfx[4:8]))
			out.Bitrate = int(binary.LittleEndian.Uint32(wfx[8:12])) * 8
			out.BitDepth = int(binary.LittleEndian.Uint16(wfx[14:16]))
			switch codecID {
			case 0x0160:
				out.Codec = "wma"
			case 0x0161:
				out.Codec = "wma2"
			case 0x0162:
				out.Codec = "wma-pro"
			case 0x0163:
				out.Codec = "wma-lossless"
			case 0x0A:
				out.Codec = "wma-voice"
			case 0x01:
				out.Codec = "pcm"
			}
		}
		cursor += int64(size)
	}
	if out.Duration > 0 && out.Bitrate == 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- TrueAudio (TTA) -------------------------------------------------

// readTTAAudio decodes the 22-byte TTA1 frame header. Skips any
// prepended ID3v2 tag so it works on ID3-wrapped TTA files too.
// Reference: TTA lossless audio codec, format specification
// (en.true-audio.com).
func (f *File) readTTAAudio() AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	var hdr [22]byte
	if _, err := f.src.ReadAt(hdr[:], start); err != nil {
		return AudioProperties{}
	}
	if string(hdr[0:4]) != "TTA1" {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "tta"}
	out.Channels = int(binary.LittleEndian.Uint16(hdr[6:8]))
	out.BitDepth = int(binary.LittleEndian.Uint16(hdr[8:10]))
	out.SampleRate = int(binary.LittleEndian.Uint32(hdr[10:14]))
	samples := binary.LittleEndian.Uint32(hdr[14:18])
	if out.SampleRate > 0 && samples > 0 {
		out.Duration = durationFromSamples(samples, out.SampleRate)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- TAK -------------------------------------------------------------

func (f *File) readTAKAudio() AudioProperties {
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	var magic [4]byte
	if _, err := f.src.ReadAt(magic[:], start); err != nil {
		return AudioProperties{}
	}
	if string(magic[:]) != "tBaK" {
		return AudioProperties{}
	}
	cursor := start + 4
	for cursor+4 <= f.size {
		var hdr [4]byte
		if _, err := f.src.ReadAt(hdr[:], cursor); err != nil {
			return AudioProperties{}
		}
		blockType := hdr[0] & 0x7F
		blockSize := int64(hdr[1]) | int64(hdr[2])<<8 | int64(hdr[3])<<16
		cursor += 4
		if blockType == 0 {
			break
		}
		if blockSize < 3 || cursor+blockSize > f.size {
			return AudioProperties{}
		}
		if blockType != 1 {
			cursor += blockSize
			continue
		}
		payload := make([]byte, blockSize-3)
		if _, err := f.src.ReadAt(payload, cursor); err != nil {
			return AudioProperties{}
		}
		br := bitReaderLE{data: payload}
		br.read(6) // codec/profile are not exposed here
		br.read(4)
		br.read(4) // frame duration type
		samples, ok := br.read(35)
		if !ok {
			return AudioProperties{}
		}
		br.read(3) // data type
		sr, ok := br.read(18)
		if !ok {
			return AudioProperties{}
		}
		bps, ok := br.read(5)
		if !ok {
			return AudioProperties{}
		}
		ch, ok := br.read(4)
		if !ok {
			return AudioProperties{}
		}
		out := AudioProperties{
			Codec:      "tak",
			SampleRate: int(sr) + 6000,
			BitDepth:   int(bps) + 8,
			Channels:   int(ch) + 1,
		}
		if out.SampleRate > 0 && samples > 0 {
			out.Duration = durationFromSamples(samples, out.SampleRate)
		}
		if out.Duration > 0 {
			out.Bitrate = bitrateBps(f.size, out.Duration)
		}
		return out
	}
	return AudioProperties{}
}

// -- CAF -------------------------------------------------------------

// readCAFAudio walks the Core Audio Format chunk list for the 'desc'
// chunk (CAFAudioDescription) and, when present, 'pakt' for the
// packet count that yields the file duration.
// Reference: Apple Core Audio Format Specification 1.0, "The Audio
// Description Chunk".
func (f *File) readCAFAudio() AudioProperties {
	var magic [4]byte
	if _, err := f.src.ReadAt(magic[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(magic[:]) != "caff" {
		return AudioProperties{}
	}
	out := AudioProperties{Codec: "caf"}
	var descSampleRate float64
	var framesPerPacket, bytesPerPacket uint32
	var bitsPerChannel uint32
	var packets int64
	cursor := int64(8) // 4 magic + 2 version + 2 flags
	for cursor+12 <= f.size {
		var hdr [12]byte
		if _, err := f.src.ReadAt(hdr[:], cursor); err != nil {
			return out
		}
		id := string(hdr[0:4])
		size := int64(binary.BigEndian.Uint64(hdr[4:12]))
		dataAt := cursor + 12
		if size < 0 || dataAt+size > f.size {
			return out
		}
		switch id {
		case "desc":
			var body [32]byte
			if _, err := f.src.ReadAt(body[:], dataAt); err == nil {
				descSampleRate = math.Float64frombits(binary.BigEndian.Uint64(body[0:8]))
				codec := string(body[8:12])
				bytesPerPacket = binary.BigEndian.Uint32(body[16:20])
				framesPerPacket = binary.BigEndian.Uint32(body[20:24])
				channels := binary.BigEndian.Uint32(body[24:28])
				bitsPerChannel = binary.BigEndian.Uint32(body[28:32])
				out.Channels = int(channels)
				out.BitDepth = int(bitsPerChannel)
				switch codec {
				case "lpcm":
					out.Codec = "pcm"
				case "aac ":
					out.Codec = "aac"
				case "alac":
					out.Codec = "alac"
				default:
					out.Codec = codec
				}
			}
		case "pakt":
			var body [16]byte
			if _, err := f.src.ReadAt(body[:], dataAt); err == nil {
				packets = int64(binary.BigEndian.Uint64(body[0:8]))
			}
		case "data":
			if framesPerPacket > 0 && bytesPerPacket > 0 {
				packets = size / int64(bytesPerPacket)
			}
		}
		cursor = dataAt + size
	}
	out.SampleRate = int(descSampleRate)
	if out.SampleRate > 0 && packets > 0 && framesPerPacket > 0 {
		samples := packets * int64(framesPerPacket)
		out.Duration = durationFromSamples(samples, out.SampleRate)
	}
	if out.Duration > 0 {
		out.Bitrate = bitrateBps(f.size, out.Duration)
	}
	return out
}

// -- OMA / ATRAC -----------------------------------------------------

// readOMAAudio reads basic codec info from the EA3 header used by
// Sony's OpenMG Audio container. Only the codec name is reported;
// sample rate and channel count live in codec-specific side data
// we do not decode.
func (f *File) readOMAAudio() AudioProperties {
	var magic [3]byte
	if _, err := f.src.ReadAt(magic[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(magic[:]) != "ea3" {
		return AudioProperties{}
	}
	return AudioProperties{Codec: "atrac"}
}

// -- RealMedia -------------------------------------------------------

func (f *File) readRealMediaAudio() AudioProperties {
	var head [18]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	switch string(head[:4]) {
	case ".RMF":
		return f.readRMFAudio()
	case ".ra\xfd":
		return f.readRAAudioAt(0, f.size)
	default:
		return AudioProperties{}
	}
}

func (f *File) readRMFAudio() AudioProperties {
	out := AudioProperties{}
	_, _, objs, err := scanRealMediaObjects(f.src, f.size)
	if err == nil {
		for _, obj := range objs {
			if obj.Size < 10 {
				continue
			}
			dataAt := obj.Offset + 10
			switch obj.ID {
			case "PROP":
				if obj.Size >= 10+26 {
					var body [26]byte
					if _, err := f.src.ReadAt(body[:], dataAt); err == nil {
						out.Bitrate = int(binary.BigEndian.Uint32(body[4:8]))
						durMS := binary.BigEndian.Uint32(body[20:24])
						if durMS > 0 {
							out.Duration = time.Duration(durMS) * time.Millisecond
						}
					}
				}
			case "MDPR":
				mdpr, ok := f.readMDPRAudio(dataAt, obj.Size-10)
				if !ok {
					continue
				}
				if out.Codec == "" {
					out.Codec = mdpr.Codec
				}
				if out.SampleRate == 0 {
					out.SampleRate = mdpr.SampleRate
				}
				if out.Channels == 0 {
					out.Channels = mdpr.Channels
				}
				if out.BitDepth == 0 {
					out.BitDepth = mdpr.BitDepth
				}
				if out.Bitrate == 0 {
					out.Bitrate = mdpr.Bitrate
				}
				if out.Duration == 0 {
					out.Duration = mdpr.Duration
				}
			}
		}
	}
	if out.Codec == "" {
		const searchLimit = 1 << 20
		n := int64(searchLimit)
		if n > f.size {
			n = f.size
		}
		if n > 0 {
			buf := make([]byte, n)
			if _, err := f.src.ReadAt(buf, 0); err == nil {
				if idx := bytes.Index(buf, []byte("PROP")); idx >= 0 && idx+10+26 <= len(buf) {
					body := buf[idx+10 : idx+10+26]
					if out.Bitrate == 0 {
						out.Bitrate = int(binary.BigEndian.Uint32(body[4:8]))
					}
					if out.Duration == 0 {
						if durMS := binary.BigEndian.Uint32(body[20:24]); durMS > 0 {
							out.Duration = time.Duration(durMS) * time.Millisecond
						}
					}
				}
				if idx := bytes.Index(buf, []byte{'.', 'r', 'a', 0xFD}); idx >= 0 {
					ra := parseRAAudio(buf[idx:])
					if out.Codec == "" {
						out.Codec = ra.Codec
					}
					if out.SampleRate == 0 {
						out.SampleRate = ra.SampleRate
					}
					if out.Channels == 0 {
						out.Channels = ra.Channels
					}
					if out.BitDepth == 0 {
						out.BitDepth = ra.BitDepth
					}
					if out.Bitrate == 0 {
						out.Bitrate = ra.Bitrate
					}
				}
			}
		}
	}
	return out
}

func (f *File) readMDPRAudio(offset, size int64) (AudioProperties, bool) {
	if size < 31 {
		return AudioProperties{}, false
	}
	buf := make([]byte, size)
	if _, err := f.src.ReadAt(buf, offset); err != nil {
		return AudioProperties{}, false
	}
	if len(buf) < 30 {
		return AudioProperties{}, false
	}
	out := AudioProperties{}
	if len(buf) >= 30 {
		out.Bitrate = int(binary.BigEndian.Uint32(buf[6:10]))
		if durMS := binary.BigEndian.Uint32(buf[26:30]); durMS > 0 {
			out.Duration = time.Duration(durMS) * time.Millisecond
		}
	}
	nameLen := int(buf[30])
	pos := 31 + nameLen
	if pos >= len(buf) {
		return out, out.Codec != "" || out.Duration > 0 || out.Bitrate > 0
	}
	mimeLen := int(buf[pos])
	pos++
	if pos+mimeLen > len(buf) {
		return out, out.Codec != "" || out.Duration > 0 || out.Bitrate > 0
	}
	pos += mimeLen
	if pos+4 > len(buf) {
		return out, out.Codec != "" || out.Duration > 0 || out.Bitrate > 0
	}
	typeSize := int(binary.BigEndian.Uint32(buf[pos : pos+4]))
	pos += 4
	if typeSize < 0 || pos+typeSize > len(buf) {
		return out, out.Codec != "" || out.Duration > 0 || out.Bitrate > 0
	}
	ra := parseRAAudio(buf[pos : pos+typeSize])
	if ra.Codec == "" {
		if idx := bytes.Index(buf, []byte{'.', 'r', 'a', 0xFD}); idx >= 0 {
			ra = parseRAAudio(buf[idx:])
		}
	}
	if ra.Codec != "" {
		if out.Codec == "" {
			out.Codec = ra.Codec
		}
		if out.SampleRate == 0 {
			out.SampleRate = ra.SampleRate
		}
		if out.Channels == 0 {
			out.Channels = ra.Channels
		}
		if out.BitDepth == 0 {
			out.BitDepth = ra.BitDepth
		}
		if out.Bitrate == 0 {
			out.Bitrate = ra.Bitrate
		}
	}
	return out, out.Codec != "" || out.Duration > 0 || out.Bitrate > 0
}

func (f *File) readRAAudioAt(offset, size int64) AudioProperties {
	if offset >= size {
		return AudioProperties{}
	}
	// RealAudio headers are at most a few hundred bytes.
	const maxRAHeaderBytes = 4 << 10
	n := size - offset
	if n > maxRAHeaderBytes {
		n = maxRAHeaderBytes
	}
	buf := make([]byte, n)
	if _, err := f.src.ReadAt(buf, offset); err != nil && err != io.EOF {
		return AudioProperties{}
	}
	return parseRAAudio(buf)
}

func parseRAAudio(buf []byte) AudioProperties {
	if len(buf) < 8 || string(buf[:4]) != ".ra\xfd" {
		return AudioProperties{}
	}
	version := binary.BigEndian.Uint16(buf[4:6])
	switch version {
	case 3:
		return AudioProperties{
			Codec:      "realaudio",
			SampleRate: 8000,
			Channels:   1,
			Bitrate:    8000,
		}
	case 4, 5:
		if len(buf) < 56 {
			return AudioProperties{Codec: "realaudio"}
		}
		out := AudioProperties{
			SampleRate: int(binary.BigEndian.Uint16(buf[48:50])),
			BitDepth:   int(binary.BigEndian.Uint16(buf[52:54])),
			Channels:   int(binary.BigEndian.Uint16(buf[54:56])),
		}
		pos := 56
		if pos >= len(buf) {
			out.Codec = "realaudio"
			return out
		}
		interleaveLen := int(buf[pos])
		pos++
		if pos+interleaveLen > len(buf) {
			out.Codec = "realaudio"
			return out
		}
		pos += interleaveLen
		if pos >= len(buf) {
			out.Codec = "realaudio"
			return out
		}
		fourCCLen := int(buf[pos])
		pos++
		if fourCCLen <= 0 || pos+fourCCLen > len(buf) {
			out.Codec = "realaudio"
			return out
		}
		out.Codec = mapRealAudioCodec(string(buf[pos : pos+fourCCLen]))
		return out
	default:
		return AudioProperties{Codec: "realaudio"}
	}
}

func mapRealAudioCodec(fourCC string) string {
	switch fourCC {
	case "dnet":
		return "ac3"
	case "raac", "racp":
		return "aac"
	case "cook":
		return "cook"
	case "sipr":
		return "sipr"
	case "lpcJ":
		return "realaudio"
	default:
		return strings.ToLower(strings.TrimSpace(fourCC))
	}
}

// -- Tracker modules -------------------------------------------------

func (f *File) readTrackerAudio() AudioProperties {
	switch f.container.Kind() {
	case ContainerMOD:
		return f.readMODAudio()
	case ContainerS3M:
		return f.readS3MAudio()
	case ContainerXM:
		return f.readXMAudio()
	case ContainerIT:
		return f.readITAudio()
	default:
		return AudioProperties{}
	}
}

func (f *File) readMODAudio() AudioProperties {
	if f.size < 1084 {
		return AudioProperties{}
	}
	var sig [4]byte
	if _, err := f.src.ReadAt(sig[:], 1080); err != nil {
		return AudioProperties{}
	}
	channels := modChannelCount(string(sig[:]))
	if channels == 0 {
		return AudioProperties{}
	}
	return AudioProperties{
		Codec:    "mod",
		Channels: channels,
	}
}

func modChannelCount(sig string) int {
	switch sig {
	case "M.K.", "M!K!", "M&K!", "N.T.":
		return 4
	case "CD81", "OKTA":
		return 8
	}
	if strings.HasPrefix(sig, "FLT") || strings.HasPrefix(sig, "TDZ") {
		if n := int(sig[3] - '0'); n > 0 && n <= 9 {
			return n
		}
	}
	if strings.HasSuffix(sig, "CHN") {
		if n := parseASCIIInt(sig[:len(sig)-3]); n > 0 {
			return n
		}
	}
	if strings.HasSuffix(sig, "CH") || strings.HasSuffix(sig, "CN") {
		if n := parseASCIIInt(sig[:len(sig)-2]); n > 0 {
			return n
		}
	}
	return 0
}

func parseASCIIInt(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func (f *File) readS3MAudio() AudioProperties {
	if f.size < 96 {
		return AudioProperties{}
	}
	var head [96]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	if head[28] != 0x1A || head[29] != 0x10 || string(head[44:48]) != "SCRM" {
		return AudioProperties{}
	}
	channels := 0
	for _, v := range head[64:96] {
		if v < 16 {
			channels++
		}
	}
	return AudioProperties{
		Codec:    "s3m",
		Channels: channels,
	}
}

func (f *File) readXMAudio() AudioProperties {
	if f.size < 80 {
		return AudioProperties{}
	}
	var head [80]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(head[:17]) != "Extended Module: " {
		return AudioProperties{}
	}
	return AudioProperties{
		Codec:    "xm",
		Channels: int(binary.LittleEndian.Uint16(head[68:70])),
	}
}

func (f *File) readITAudio() AudioProperties {
	if f.size < 64 {
		return AudioProperties{}
	}
	var head [4]byte
	if _, err := f.src.ReadAt(head[:], 0); err != nil {
		return AudioProperties{}
	}
	if string(head[:]) != "IMPM" {
		return AudioProperties{}
	}
	return AudioProperties{
		Codec:    "it",
		Channels: 64,
	}
}
