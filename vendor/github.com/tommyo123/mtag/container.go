package mtag

import (
	"encoding/binary"
	"errors"
	"io"
	"strings"

	"github.com/tommyo123/mtag/id3v2"
)

// ContainerKind identifies the outer file wrapper.
type ContainerKind uint8

const (
	ContainerMP3       ContainerKind = iota // raw audio with ID3 prepended/appended
	ContainerWAV                            // RIFF / WAVE wrapper
	ContainerAIFF                           // FORM / AIFF or AIFC wrapper
	ContainerFLAC                           // free-lossless FLAC stream (Vorbis Comments)
	ContainerMP4                            // MP4 / M4A / M4B with iTunes ilst metadata
	ContainerOGG                            // Ogg container with Vorbis / Opus / Speex comments
	ContainerMAC                            // Monkey's Audio file ("MAC " magic), APE-tag native
	ContainerAAC                            // AAC / ADTS bitstream with optional prepended ID3 tags
	ContainerAC3                            // raw AC-3 / E-AC-3 bitstream with optional prepended ID3
	ContainerDTS                            // raw DTS bitstream with optional prepended ID3
	ContainerAMR                            // AMR / AMR-WB bitstream with optional prepended ID3
	ContainerWavPack                        // WavPack ("wvpk" magic), APE-tag native
	ContainerMPC                            // Musepack SV7 ("MP+") / SV8 ("MPCK"), APE-tag native
	ContainerASF                            // ASF / WMA wrapper with native metadata objects
	ContainerDSF                            // DSD Stream File with trailing ID3v2 metadata pointer
	ContainerDFF                            // DSDIFF / DFF with optional trailing "ID3 " chunk
	ContainerMatroska                       // Matroska / WebM with native Info/SimpleTag metadata
	ContainerTTA                            // TrueAudio stream with ID3/APE placement like bare audio
	ContainerTAK                            // TAK stream with trailing APEv2 metadata
	ContainerW64                            // Sony Wave64 wrapper with native summary metadata
	ContainerMOD                            // ProTracker / compatible MOD module
	ContainerS3M                            // Scream Tracker III module
	ContainerXM                             // FastTracker II extended module
	ContainerIT                             // Impulse Tracker module
	ContainerRealMedia                      // RealAudio / RealMedia (.ra / .rm)
	ContainerCAF                            // Apple Core Audio Format ("caff" magic)
	ContainerOMA                            // Sony OpenMG Audio / ATRAC (.oma / .aa3 / .at3, "ea3" magic)
)

const ContainerUnknown ContainerKind = 0xFF

func (c ContainerKind) String() string {
	switch c {
	case ContainerMP3:
		return "mp3"
	case ContainerWAV:
		return "wav"
	case ContainerAIFF:
		return "aiff"
	case ContainerFLAC:
		return "flac"
	case ContainerMP4:
		return "mp4"
	case ContainerOGG:
		return "ogg"
	case ContainerMAC:
		return "mac"
	case ContainerAAC:
		return "aac"
	case ContainerAC3:
		return "ac3"
	case ContainerDTS:
		return "dts"
	case ContainerAMR:
		return "amr"
	case ContainerWavPack:
		return "wavpack"
	case ContainerMPC:
		return "mpc"
	case ContainerASF:
		return "asf"
	case ContainerDSF:
		return "dsf"
	case ContainerDFF:
		return "dff"
	case ContainerMatroska:
		return "matroska"
	case ContainerTTA:
		return "tta"
	case ContainerTAK:
		return "tak"
	case ContainerW64:
		return "w64"
	case ContainerMOD:
		return "mod"
	case ContainerS3M:
		return "s3m"
	case ContainerXM:
		return "xm"
	case ContainerIT:
		return "it"
	case ContainerRealMedia:
		return "realmedia"
	case ContainerCAF:
		return "caf"
	case ContainerOMA:
		return "oma"
	}
	return "unknown"
}

// Container is the polymorphic interface every supported on-disk
// wrapper implements. It owns its format's metadata-detection and
// save logic so the polymorphic [*File] does not need to switch on
// kind in hot paths. The interface is intentionally small: callers
// outside the package interact via [File] and [TagKind]; concrete
// container types are unexported.
type Container interface {
	Kind() ContainerKind
	String() string
	// info exposes the shared per-container bookkeeping (chunk
	// offsets, byte order, ...). Unexported so external callers
	// can't reach into format internals.
	info() *containerInfo
	detectMetadata(f *File, cfg openConfig) error
	saveMetadata(f *File) error
}

// containerInfo records where v2 / v1 regions live inside the file.
// All offsets are absolute. v2Offset = -1 means "no v2 region".
// Embedded by every concrete container so common bookkeeping is in
// one place.
type containerInfo struct {
	kind      ContainerKind
	v2Offset  int64 // start of the ID3v2 region (or -1)
	v2Bound   int64 // upper bound on how much we may read at v2Offset
	v1Allowed bool  // false for WAV/AIFF; they do not carry v1 footers
	wave64    bool

	// RIFF / FORM bookkeeping for the rewriter.
	outerMagic  [4]byte // "RIFF" / "RF64" / "BW64" / "FORM"
	v2ChunkAt   int64   // offset of the id3 chunk header (or -1)
	v2ChunkID   [4]byte // preserved as written, e.g. "id3 " vs "ID3 "
	wrapperKind [4]byte // "WAVE" / "AIFF" / "AIFC"
	byteOrder   byteOrder
}

// Kind / String / info live on containerInfo so every concrete
// container gets them by struct-embedding. Save / Detect stay
// per-type.
func (c *containerInfo) Kind() ContainerKind  { return c.kind }
func (c *containerInfo) String() string       { return c.kind.String() }
func (c *containerInfo) info() *containerInfo { return c }

// byteOrder is the trivial enum used by the RIFF / FORM walker.
type byteOrder uint8

const (
	orderLE byteOrder = iota
	orderBE
)

// ErrContainerWriteUnsupported is returned by Save when the file uses
// a container format mtag can read but cannot yet rewrite.
var ErrContainerWriteUnsupported = errors.New("mtag: write back not implemented for this container")

// detectContainer inspects the first bytes of the file and returns the
// matching [Container]. Unknown magic falls back to a bare MP3-style
// container.
func detectContainer(r io.ReaderAt, size int64) Container {
	mp3 := func() Container {
		return &mp3Container{containerInfo: containerInfo{
			kind: ContainerMP3, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	}
	if size < 4 {
		return mp3()
	}
	var head [40]byte
	readLen := len(head)
	if size < int64(readLen) {
		readLen = int(size)
	}
	if _, err := r.ReadAt(head[:readLen], 0); err != nil && !(errors.Is(err, io.EOF) && readLen > 0) {
		return mp3()
	}
	if head[0] == 'I' && head[1] == 'D' && head[2] == '3' {
		if hdr, err := id3v2.ReadHeader(head[:]); err == nil {
			offset := int64(id3v2.HeaderSize) + int64(hdr.Size)
			if hdr.Major == 4 && hdr.Flags&0x10 != 0 {
				offset += int64(id3v2.HeaderSize)
			}
			if offset+4 <= size {
				var after4 [4]byte
				if _, err := r.ReadAt(after4[:], offset); err == nil {
					if after4[0] == 'T' && after4[1] == 'T' && after4[2] == 'A' {
						return &ttaContainer{containerInfo: containerInfo{
							kind: ContainerTTA, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
					if after4[0] == 't' && after4[1] == 'B' && after4[2] == 'a' && after4[3] == 'K' {
						return &takContainer{containerInfo: containerInfo{
							kind: ContainerTAK, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
					// FLAC streams sometimes carry a prepended ID3v2
					// block. That is not the canonical layout but
					// several real-world taggers emit it; treat the
					// file as FLAC when the fLaC magic follows the
					// ID3 region.
					if after4[0] == 'f' && after4[1] == 'L' && after4[2] == 'a' && after4[3] == 'C' {
						return &flacContainer{containerInfo: containerInfo{
							kind: ContainerFLAC, v2Offset: -1,
						}}
					}
				}
			}
			if offset+12 <= size {
				var after [12]byte
				if _, err := r.ReadAt(after[:], offset); err == nil {
					if after[0] == 0xFF && (after[1]&0xF6) == 0xF0 {
						return &aacContainer{containerInfo: containerInfo{
							kind: ContainerAAC, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
					if after[0] == 0x0B && after[1] == 0x77 {
						return &ac3Container{containerInfo: containerInfo{
							kind: ContainerAC3, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
					if isDTSSync(after[:4]) {
						return &dtsContainer{containerInfo: containerInfo{
							kind: ContainerDTS, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
					if isAMRMagic(after[:]) {
						return &amrContainer{containerInfo: containerInfo{
							kind: ContainerAMR, v2Offset: 0, v2Bound: size, v1Allowed: true,
						}}
					}
				}
			}
		}
	}
	switch {
	case size >= 40 && isWave64FileHeader(head[:readLen]):
		return &w64Container{containerInfo: containerInfo{
			kind: ContainerW64, v2Offset: -1, wave64: true,
		}}
	case head[0] == 't' && head[1] == 'B' && head[2] == 'a' && head[3] == 'K':
		return &takContainer{containerInfo: containerInfo{
			kind: ContainerTAK, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	case head[0] == 'T' && head[1] == 'T' && head[2] == 'A':
		return &ttaContainer{containerInfo: containerInfo{
			kind: ContainerTTA, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	case isAMRMagic(head[:]):
		return &amrContainer{containerInfo: containerInfo{
			kind: ContainerAMR, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	case size >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F' &&
		head[8] == 'W' && head[9] == 'A' && head[10] == 'V' && head[11] == 'E':
		info := scanRIFFContainer(r, size, ContainerWAV, binary.LittleEndian, [4]byte{'R', 'I', 'F', 'F'})
		info.byteOrder = orderLE
		copy(info.outerMagic[:], head[0:4])
		copy(info.wrapperKind[:], head[8:12])
		return &wavContainer{containerInfo: info}
	case size >= 12 && ((head[0] == 'R' && head[1] == 'F' && head[2] == '6' && head[3] == '4') ||
		(head[0] == 'B' && head[1] == 'W' && head[2] == '6' && head[3] == '4')) &&
		head[8] == 'W' && head[9] == 'A' && head[10] == 'V' && head[11] == 'E':
		var outer [4]byte
		copy(outer[:], head[0:4])
		info := scanRIFFContainer(r, size, ContainerWAV, binary.LittleEndian, outer)
		info.byteOrder = orderLE
		copy(info.outerMagic[:], head[0:4])
		copy(info.wrapperKind[:], head[8:12])
		return &wavContainer{containerInfo: info}
	case size >= 12 && head[0] == 'F' && head[1] == 'O' && head[2] == 'R' && head[3] == 'M' &&
		(string(head[8:12]) == "AIFF" || string(head[8:12]) == "AIFC"):
		info := scanRIFFContainer(r, size, ContainerAIFF, binary.BigEndian, [4]byte{'F', 'O', 'R', 'M'})
		info.byteOrder = orderBE
		copy(info.outerMagic[:], head[0:4])
		copy(info.wrapperKind[:], head[8:12])
		return &aiffContainer{containerInfo: info}
	case head[0] == 'f' && head[1] == 'L' && head[2] == 'a' && head[3] == 'C':
		return &flacContainer{containerInfo: containerInfo{kind: ContainerFLAC, v2Offset: -1}}
	case head[0] == 'c' && head[1] == 'a' && head[2] == 'f' && head[3] == 'f':
		return &cafContainer{containerInfo: containerInfo{kind: ContainerCAF, v2Offset: -1}}
	case head[0] == 'e' && head[1] == 'a' && head[2] == '3' &&
		head[3] >= 2 && head[3] <= 4 && head[3] != 0xFF && head[4] != 0xFF:
		return &omaContainer{containerInfo: containerInfo{
			kind: ContainerOMA, v2Offset: 0, v2Bound: size,
		}}
	case size >= 8 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p':
		return &mp4Container{containerInfo: containerInfo{kind: ContainerMP4, v2Offset: -1}}
	case head[0] == 'O' && head[1] == 'g' && head[2] == 'g' && head[3] == 'S':
		return &oggContainer{containerInfo: containerInfo{kind: ContainerOGG, v2Offset: -1}}
	case head[0] == 0x30 && head[1] == 0x26 && head[2] == 0xB2 && head[3] == 0x75 &&
		head[4] == 0x8E && head[5] == 0x66 && head[6] == 0xCF && head[7] == 0x11:
		return &asfContainer{containerInfo: containerInfo{kind: ContainerASF, v2Offset: -1}}
	case head[0] == '.' && head[1] == 'R' && head[2] == 'M' && head[3] == 'F':
		return &realMediaContainer{containerInfo: containerInfo{kind: ContainerRealMedia, v2Offset: -1}}
	case head[0] == '.' && head[1] == 'r' && head[2] == 'a' && head[3] == 0xFD:
		return &realMediaContainer{containerInfo: containerInfo{kind: ContainerRealMedia, v2Offset: -1}}
	case head[0] == 0x1A && head[1] == 0x45 && head[2] == 0xDF && head[3] == 0xA3:
		return &matroskaContainer{containerInfo: containerInfo{kind: ContainerMatroska, v2Offset: -1}}
	case size >= 12 && head[0] == 'D' && head[1] == 'S' && head[2] == 'D' && head[3] == ' ':
		info := scanDSFContainer(r, size)
		return &dsfContainer{containerInfo: info}
	case size >= 16 && head[0] == 'F' && head[1] == 'R' && head[2] == 'M' && head[3] == '8':
		var dffHead [16]byte
		if _, err := r.ReadAt(dffHead[:], 0); err == nil && string(dffHead[12:16]) == "DSD " {
			info := scanDFFContainer(r, size)
			return &dffContainer{containerInfo: info}
		}
	case head[0] == 'M' && head[1] == 'A' && head[2] == 'C' && head[3] == ' ':
		return &macContainer{containerInfo: containerInfo{kind: ContainerMAC, v2Offset: -1}}
	case head[0] == 'w' && head[1] == 'v' && head[2] == 'p' && head[3] == 'k':
		return &wavPackContainer{containerInfo: containerInfo{kind: ContainerWavPack, v2Offset: -1}}
	case head[0] == 'M' && head[1] == 'P' && head[2] == 'C' && head[3] == 'K':
		return &mpcContainer{containerInfo: containerInfo{kind: ContainerMPC, v2Offset: -1}}
	case head[0] == 'M' && head[1] == 'P' && head[2] == '+':
		return &mpcContainer{containerInfo: containerInfo{kind: ContainerMPC, v2Offset: -1}}
	case head[0] == 0xFF && (head[1]&0xF6) == 0xF0:
		// ADTS sync word: 12 bits set plus layer=00. The mask
		// allows both MPEG-2 and MPEG-4 AAC variants.
		return &aacContainer{containerInfo: containerInfo{
			kind: ContainerAAC, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	case head[0] == 0x0B && head[1] == 0x77:
		return &ac3Container{containerInfo: containerInfo{
			kind: ContainerAC3, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	case isDTSSync(head[:4]):
		return &dtsContainer{containerInfo: containerInfo{
			kind: ContainerDTS, v2Offset: 0, v2Bound: size, v1Allowed: true,
		}}
	}
	if size >= 48 {
		var s3m [20]byte
		if _, err := r.ReadAt(s3m[:], 28); err == nil &&
			s3m[0] == 0x1A && s3m[1] == 0x10 &&
			string(s3m[16:20]) == "SCRM" {
			return &trackerContainer{containerInfo: containerInfo{kind: ContainerS3M, v2Offset: -1}}
		}
	}
	if size >= 1084 {
		var modSig [4]byte
		if _, err := r.ReadAt(modSig[:], 1080); err == nil {
			if _, _, ok := decodeMODSignature(string(modSig[:])); ok {
				return &trackerContainer{containerInfo: containerInfo{kind: ContainerMOD, v2Offset: -1}}
			}
		}
	}
	if size >= 60 {
		var xm [17]byte
		if _, err := r.ReadAt(xm[:], 0); err == nil && string(xm[:]) == "Extended Module: " {
			return &trackerContainer{containerInfo: containerInfo{kind: ContainerXM, v2Offset: -1}}
		}
	}
	if head[0] == 'I' && head[1] == 'M' && head[2] == 'P' && head[3] == 'M' {
		return &trackerContainer{containerInfo: containerInfo{kind: ContainerIT, v2Offset: -1}}
	}
	return mp3()
}

// --- concrete container types --------------------------------------
//
// Each type embeds containerInfo so it picks up Kind() + String()
// for free. Detect / Save logic is split per-type so the dispatch
// is interface-driven rather than a switch on kind.

type mp3Container struct{ containerInfo }
type wavContainer struct{ containerInfo }
type aiffContainer struct{ containerInfo }
type flacContainer struct{ containerInfo }
type mp4Container struct{ containerInfo }
type oggContainer struct{ containerInfo }
type macContainer struct{ containerInfo }
type aacContainer struct{ containerInfo }
type ac3Container struct{ containerInfo }
type dtsContainer struct{ containerInfo }
type amrContainer struct{ containerInfo }
type wavPackContainer struct{ containerInfo }
type mpcContainer struct{ containerInfo }
type asfContainer struct{ containerInfo }
type dsfContainer struct{ containerInfo }
type dffContainer struct{ containerInfo }
type matroskaContainer struct{ containerInfo }
type ttaContainer struct{ containerInfo }
type takContainer struct{ containerInfo }
type w64Container struct{ containerInfo }
type trackerContainer struct{ containerInfo }
type realMediaContainer struct{ containerInfo }
type cafContainer struct{ containerInfo }
type omaContainer struct{ containerInfo }

func (c *mp3Container) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *wavContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectRIFF(cfg) }
func (c *aiffContainer) detectMetadata(f *File, cfg openConfig) error { return f.detectRIFF(cfg) }
func (c *flacContainer) detectMetadata(f *File, cfg openConfig) error { return f.detectFLAC(cfg) }
func (c *mp4Container) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP4(cfg) }
func (c *oggContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectOGGWith(cfg) }
func (c *macContainer) detectMetadata(f *File, _ openConfig) error    { return f.detectAPETail(f.size) }
func (c *aacContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *ac3Container) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *dtsContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *amrContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *ttaContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *takContainer) detectMetadata(f *File, cfg openConfig) error  { return f.detectMP3(cfg) }
func (c *wavPackContainer) detectMetadata(f *File, _ openConfig) error {
	return f.detectAPETail(f.size)
}
func (c *mpcContainer) detectMetadata(f *File, cfg openConfig) error {
	if err := f.detectMP3(cfg); err != nil {
		return err
	}
	return f.detectAPETail(f.size)
}
func (c *asfContainer) detectMetadata(f *File, cfg openConfig) error { return f.detectASFWith(cfg) }
func (c *dsfContainer) detectMetadata(f *File, cfg openConfig) error { return f.detectSingleV2(cfg) }
func (c *dffContainer) detectMetadata(f *File, cfg openConfig) error { return f.detectSingleV2(cfg) }
func (c *matroskaContainer) detectMetadata(f *File, cfg openConfig) error {
	return f.detectMatroskaWith(cfg)
}
func (c *w64Container) detectMetadata(f *File, cfg openConfig) error   { return f.detectRIFF(cfg) }
func (c *trackerContainer) detectMetadata(f *File, _ openConfig) error { return f.detectTracker() }
func (c *realMediaContainer) detectMetadata(f *File, _ openConfig) error {
	return f.detectRealMedia()
}
func (c *cafContainer) detectMetadata(f *File, _ openConfig) error {
	f.caf = scanCAFInfo(f.src, f.size)
	return nil
}
func (c *omaContainer) detectMetadata(f *File, _ openConfig) error { return f.detectOMA() }

func (c *mp3Container) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *wavContainer) saveMetadata(f *File) error       { return f.saveRIFFContainer() }
func (c *aiffContainer) saveMetadata(f *File) error      { return f.saveRIFFContainer() }
func (c *flacContainer) saveMetadata(f *File) error      { return f.saveFLAC() }
func (c *mp4Container) saveMetadata(f *File) error       { return f.saveMP4() }
func (c *oggContainer) saveMetadata(f *File) error       { return f.saveOGG() }
func (c *macContainer) saveMetadata(f *File) error       { return f.saveMAC() }
func (c *aacContainer) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *ac3Container) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *dtsContainer) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *amrContainer) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *ttaContainer) saveMetadata(f *File) error       { return f.saveMP3() }
func (c *takContainer) saveMetadata(f *File) error       { return f.saveMAC() }
func (c *wavPackContainer) saveMetadata(f *File) error   { return f.saveMAC() }
func (c *mpcContainer) saveMetadata(f *File) error       { return f.saveMAC() }
func (c *asfContainer) saveMetadata(f *File) error       { return f.saveASF() }
func (c *dsfContainer) saveMetadata(f *File) error       { return f.saveDSF() }
func (c *dffContainer) saveMetadata(f *File) error       { return f.saveDFF() }
func (c *matroskaContainer) saveMetadata(f *File) error  { return f.saveMatroska() }
func (c *trackerContainer) saveMetadata(f *File) error   { return f.saveTracker() }
func (c *realMediaContainer) saveMetadata(f *File) error { return f.saveRealMedia() }
func (c *cafContainer) saveMetadata(f *File) error       { return f.saveCAF() }
func (c *omaContainer) saveMetadata(f *File) error       { return f.saveOMA() }
func (c *w64Container) saveMetadata(f *File) error       { return f.saveW64Container() }

// scanRIFFContainer walks the chunk list of a RIFF (WAV) or FORM
// (AIFF) file and returns the byte range of the first ID3 chunk.
// The chunk size encoding differs by container. WAV uses
// little-endian 32-bit sizes, AIFF uses big-endian. Other than the
// byte order, the chunk-walking logic is identical.
func scanRIFFContainer(r io.ReaderAt, size int64, kind ContainerKind, order binary.ByteOrder, outerMagic [4]byte) containerInfo {
	info := containerInfo{kind: kind, v2Offset: -1, v2ChunkAt: -1, outerMagic: outerMagic}
	if isRF64Magic(outerMagic) {
		for _, c := range listIFFChunks(r, size, order, outerMagic) {
			if strings.EqualFold(string(c.ID[:]), "id3 ") {
				info.v2Offset = c.DataAt
				info.v2Bound = c.DataSize
				info.v2ChunkAt = c.HeaderAt
				info.v2ChunkID = c.ID
				break
			}
		}
		return info
	}
	const minChunkHdr = 8
	cursor := int64(12) // skip the RIFF/FORM container header
	for cursor+minChunkHdr <= size {
		var hdr [minChunkHdr]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			if hit, ok := scanForwardForIFFChunk(r, cursor+1, size, order, func(id [4]byte) bool {
				return strings.EqualFold(string(id[:]), "id3 ")
			}); ok {
				info.v2Offset = hit.DataAt
				info.v2Bound = hit.DataSize
				info.v2ChunkAt = hit.HeaderAt
				info.v2ChunkID = hit.ID
			}
			return info
		}
		id := string(hdr[:4])
		// Chunk size is the size of the data, not the header.
		dataSize := int64(order.Uint32(hdr[4:8]))
		dataStart := cursor + minChunkHdr
		if dataSize < 0 || dataStart+dataSize > size {
			// Malformed. One bad size field should not hide a
			// later ID3 chunk completely.
			if hit, ok := scanForwardForIFFChunk(r, cursor+1, size, order, func(id [4]byte) bool {
				return strings.EqualFold(string(id[:]), "id3 ")
			}); ok {
				info.v2Offset = hit.DataAt
				info.v2Bound = hit.DataSize
				info.v2ChunkAt = hit.HeaderAt
				info.v2ChunkID = hit.ID
			}
			return info
		}
		// WAV strictly uses lowercase "id3 ", AIFF uses "ID3 ", but
		// real files mix the case. Match either spelling.
		if strings.EqualFold(id, "id3 ") {
			info.v2Offset = dataStart
			info.v2Bound = dataSize
			info.v2ChunkAt = cursor
			copy(info.v2ChunkID[:], hdr[:4])
			return info
		}
		// RIFF chunks are word-aligned: an odd data size is followed
		// by a single pad byte that the size field does not cover.
		next := dataStart + dataSize
		if dataSize%2 == 1 {
			next++
		}
		cursor = next
	}
	return info
}

func isWaveContainer(kind ContainerKind) bool {
	return kind == ContainerWAV || kind == ContainerW64
}

func isDTSSync(head []byte) bool {
	if len(head) < 4 {
		return false
	}
	return (head[0] == 0x7F && head[1] == 0xFE && head[2] == 0x80 && head[3] == 0x01) ||
		(head[0] == 0xFE && head[1] == 0x7F && head[2] == 0x01 && head[3] == 0x80) ||
		(head[0] == 0x1F && head[1] == 0xFF && head[2] == 0xE8 && head[3] == 0x00) ||
		(head[0] == 0xFF && head[1] == 0x1F && head[2] == 0x00 && head[3] == 0xE8)
}

func isAMRMagic(head []byte) bool {
	if len(head) >= 9 && string(head[:9]) == "#!AMR-WB\n" {
		return true
	}
	return len(head) >= 6 && string(head[:6]) == "#!AMR\n"
}

// chunkSpan describes one top-level RIFF/FORM chunk during a
// rewrite. Offsets are absolute in the source file.
type chunkSpan struct {
	ID         [4]byte
	HeaderAt   int64 // offset of the 8-byte chunk header
	DataAt     int64 // = HeaderAt + 8
	DataSize   int64
	PaddedSize int64 // = DataSize, rounded up to even
}

// scanForwardForIFFChunk searches [from, size) for the next matching
// chunk header whose declared size stays within the file. It is used
// to resync after a malformed RIFF/AIFF chunk.
func scanForwardForIFFChunk(r io.ReaderAt, from, size int64, order binary.ByteOrder, want func([4]byte) bool) (chunkSpan, bool) {
	const (
		window  = 64 << 10
		overlap = 7
	)
	if from < 0 {
		from = 0
	}
	buf := make([]byte, window+overlap)
	for base := from; base+8 <= size; {
		readLen := int(size - base)
		if readLen > len(buf) {
			readLen = len(buf)
		}
		n, err := r.ReadAt(buf[:readLen], base)
		if n < 8 {
			return chunkSpan{}, false
		}
		if err != nil && err != io.EOF {
			return chunkSpan{}, false
		}
		for i := 0; i+8 <= n; i++ {
			var id [4]byte
			copy(id[:], buf[i:i+4])
			if !want(id) {
				continue
			}
			dataSize := int64(order.Uint32(buf[i+4 : i+8]))
			headerAt := base + int64(i)
			dataAt := headerAt + 8
			if dataAt+dataSize > size {
				continue
			}
			padded := dataSize
			if padded%2 == 1 {
				padded++
			}
			return chunkSpan{
				ID:         id,
				HeaderAt:   headerAt,
				DataAt:     dataAt,
				DataSize:   dataSize,
				PaddedSize: padded,
			}, true
		}
		if base+int64(n) >= size || n <= 8 {
			return chunkSpan{}, false
		}
		base += int64(n - overlap)
	}
	return chunkSpan{}, false
}

// listChunks walks every chunk of a RIFF/FORM file, returning them
// in the order they appear on disk. A malformed chunk list cuts the
// walk short but the chunks read so far are still returned.
func listChunks(r io.ReaderAt, size int64, order binary.ByteOrder) []chunkSpan {
	const minChunkHdr = 8
	var out []chunkSpan
	cursor := int64(12)
	for cursor+minChunkHdr <= size {
		var hdr [minChunkHdr]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			return out
		}
		dataSize := int64(order.Uint32(hdr[4:8]))
		dataStart := cursor + minChunkHdr
		if dataSize < 0 || dataStart+dataSize > size {
			return out
		}
		padded := dataSize
		if padded%2 == 1 {
			padded++
		}
		c := chunkSpan{
			HeaderAt:   cursor,
			DataAt:     dataStart,
			DataSize:   dataSize,
			PaddedSize: padded,
		}
		copy(c.ID[:], hdr[:4])
		out = append(out, c)
		cursor = dataStart + padded
	}
	return out
}
