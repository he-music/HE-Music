package mtag

import (
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag/ape"
	"github.com/tommyo123/mtag/flac"
	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/id3v2"
	"github.com/tommyo123/mtag/mp4"
)

// detect scans the file for supported metadata with default options.
func (f *File) detect() error { return f.detectWith(openConfig{}) }

// detectWith is the option-aware variant of detect.
func (f *File) detectWith(cfg openConfig) error {
	f.container = detectContainer(f.src, f.size)
	if f.container.Kind() == ContainerMP3 && strings.EqualFold(filepath.Ext(f.path), ".mpc") {
		f.container = &mpcContainer{containerInfo: containerInfo{kind: ContainerMPC, v2Offset: -1}}
	}
	if err := f.container.detectMetadata(f, cfg); err != nil {
		return err
	}
	if err := f.validateDetectedFormat(cfg); err != nil {
		return err
	}
	f.applySkipOptions(cfg)
	return nil
}

func (f *File) validateDetectedFormat(cfg openConfig) error {
	if f.Container() != ContainerMP3 {
		return nil
	}
	if f.size == 0 || f.v1 != nil || f.v2 != nil {
		return nil
	}
	if f.rw != nil && f.path == "" {
		return nil
	}
	switch strings.ToLower(filepath.Ext(f.path)) {
	case ".mp3", ".aac", ".ac3", ".dts", ".amr", ".tta", ".tak", ".mpc":
		return nil
	}
	scanLimit := f.size
	if cfg.leadingJunkScan > 0 {
		if cfg.leadingJunkScan < scanLimit {
			scanLimit = cfg.leadingJunkScan
		}
	} else if scanLimit > 1<<20 {
		scanLimit = 1 << 20
	}
	if scanLimit < 4 {
		return ErrUnsupportedFormat
	}
	if _, _, ok := findNextMPEGFrame(f.src, 0, scanLimit); ok {
		return nil
	}
	return ErrUnsupportedFormat
}

// applySkipOptions drops picture / attachment payloads when the
// caller opted into [WithSkipPictures] / [WithSkipAttachments].
// Some backends skip the heavy payloads during parse; this remains
// as a final cleanup layer so the option still works on formats
// whose parser has no native skip path yet.
func (f *File) applySkipOptions(cfg openConfig) {
	if cfg.skipPictures {
		f.dropPictures()
	}
	if cfg.skipAttachments {
		f.dropAttachments()
	}
}

func (f *File) dropPictures() {
	if f.v2 != nil {
		kept := f.v2.Frames[:0]
		dropped := false
		for _, fr := range f.v2.Frames {
			if _, ok := fr.(*id3v2.PictureFrame); ok {
				dropped = true
				continue
			}
			kept = append(kept, fr)
		}
		if dropped {
			f.v2.Frames = kept
			f.v2.InvalidateIndex()
		}
	}
	if f.flac != nil {
		f.flac.pictures = nil
		if f.flac.comment != nil {
			kept := f.flac.comment.Fields[:0]
			for _, fld := range f.flac.comment.Fields {
				if strings.EqualFold(fld.Name, "METADATA_BLOCK_PICTURE") ||
					strings.EqualFold(fld.Name, "COVERART") {
					continue
				}
				kept = append(kept, fld)
			}
			f.flac.comment.Fields = kept
		}
	}
	if f.mp4 != nil {
		kept := f.mp4.items[:0]
		for _, it := range f.mp4.items {
			if string(it.Name[:]) == "covr" {
				continue
			}
			kept = append(kept, it)
		}
		f.mp4.items = kept
	}
	if f.asf != nil {
		f.asf.Pictures = nil
	}
	if f.mkv != nil {
		f.mkv.Pictures = nil
	}
	if f.ape != nil {
		f.ape.Remove(ape.FieldCoverArtFront)
		f.ape.Remove(ape.FieldCoverArtBack)
	}
}

func (f *File) dropAttachments() {
	if f.mkv != nil {
		f.mkv.Attachments = nil
	}
}

// scanForPrependedID3 returns the offset at which prepended-tag
// detection should start scanning.
func (f *File) scanForPrependedID3(maxBytes int64) int64 {
	var head [id3v2.HeaderSize]byte
	if _, err := f.src.ReadAt(head[:], 0); err == nil {
		if head[0] == 'I' && head[1] == 'D' && head[2] == '3' {
			return 0
		}
	}
	if maxBytes <= 0 {
		return 0
	}
	if maxBytes > f.size {
		maxBytes = f.size
	}
	// Bound the caller-supplied limit to keep the allocation safe.
	const maxLeadingJunkScan = 8 << 20
	if maxBytes > maxLeadingJunkScan {
		maxBytes = maxLeadingJunkScan
	}
	buf := make([]byte, maxBytes)
	n, _ := f.src.ReadAt(buf, 0)
	for i := 0; i+id3v2.HeaderSize <= n; i++ {
		if buf[i] != 'I' || buf[i+1] != 'D' || buf[i+2] != '3' {
			continue
		}
		if buf[i+3] == 0xFF || buf[i+4] == 0xFF {
			continue
		}
		major := buf[i+3]
		if major < 2 || major > 4 {
			continue
		}
		sz := id3v2.DecodeSynchsafe(buf[i+6 : i+10])
		if int64(i)+int64(id3v2.HeaderSize)+int64(sz) > f.size {
			continue
		}
		return int64(i)
	}
	return 0
}

// detectRIFF handles WAV and AIFF metadata discovery.
func (f *File) detectRIFF(cfg openConfig) error {
	info := f.container.info()
	switch f.container.Kind() {
	case ContainerWAV:
		f.riffInfo = scanWAVInfo(f.src, f.size)
		f.bwf = scanWAVBWF(f.src, f.size)
	case ContainerW64:
		f.riffInfo = scanW64Info(f.src, f.size)
	case ContainerAIFF:
		f.riffInfo = scanAIFFText(f.src, f.size)
	}
	if cfg.skipV2 || info.v2Offset < 0 {
		return nil
	}
	return f.detectV2InRange(info.v2Offset, info.v2Bound)
}

// detectMP3 walks prepended, appended, and tail metadata stores.
func (f *File) detectMP3(cfg openConfig) error {
	if cfg.skipV2 {
		if !cfg.skipV1 {
			if err := f.detectV1Footer(); err != nil {
				return err
			}
		}
		if cfg.syncV1toV2 && f.v2 == nil && f.v1 != nil {
			f.promoteV1toV2()
		}
		return nil
	}

	offset := f.scanForPrependedID3(cfg.leadingJunkScan)
	for offset < f.size-int64(id3v2.HeaderSize) {
		var head [id3v2.HeaderSize]byte
		if _, err := f.src.ReadAt(head[:], offset); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if head[0] != 'I' || head[1] != 'D' || head[2] != '3' {
			break
		}
		hdr, hErr := id3v2.ReadHeader(head[:])
		if hErr != nil {
			break
		}
		regionSize := int64(id3v2.HeaderSize) + int64(hdr.Size)
		if hdr.Major == 4 && hdr.Flags&0x10 != 0 {
			regionSize += int64(id3v2.HeaderSize)
		}
		if offset+regionSize > f.size {
			break
		}

		tag, pErr := id3v2.ReadBounded(f.src, offset, regionSize)
		if pErr == nil {
			if f.v2 == nil {
				f.v2 = tag
			} else {
				f.v2.Merge(tag)
			}
			f.v2at = 0
			f.formats &^= FormatID3v2Any
			switch tag.Version {
			case 2:
				f.formats |= FormatID3v22
			case 3:
				f.formats |= FormatID3v23
			case 4:
				f.formats |= FormatID3v24
			}
			f.v2corrupt = false
		} else {
			f.v2corrupt = true
		}
		f.v2size += regionSize
		offset += regionSize
	}

	if !cfg.skipV1 {
		if err := f.detectV1Footer(); err != nil {
			return err
		}
	}
	if !cfg.skipV2 {
		f.detectAppendedV2()
	}
	if cfg.syncV1toV2 && f.v2 == nil && f.v1 != nil {
		f.promoteV1toV2()
	}
	return nil
}

// promoteV1toV2 synthesises an ID3v2.4 tag from the ID3v1 footer.
func (f *File) promoteV1toV2() {
	tag := id3v2.NewTag(4)
	if f.v1.Title != "" {
		tag.SetText(id3v2.FrameTitle, f.v1.Title)
	}
	if f.v1.Artist != "" {
		tag.SetText(id3v2.FrameArtist, f.v1.Artist)
	}
	if f.v1.Album != "" {
		tag.SetText(id3v2.FrameAlbum, f.v1.Album)
	}
	if y := f.v1.YearInt(); y > 0 {
		tag.SetText(id3v2.FrameRecordingTime, fmt.Sprintf("%04d", y))
	}
	if f.v1.HasTrack() {
		tag.SetText(id3v2.FrameTrack, strconv.Itoa(int(f.v1.Track)))
	}
	if name := f.v1.GenreName(); name != "" {
		tag.SetText(id3v2.FrameGenre, name)
	}
	if f.v1.Comment != "" {
		tag.Set(&id3v2.CommentFrame{
			FrameID:  id3v2.FrameComment,
			Language: "eng",
			Text:     f.v1.Comment,
		})
	}
	f.v2 = tag
	f.formats |= FormatID3v24
}

// detectAppendedV2 looks for an ID3v2.4 footer at the tail.
func (f *File) detectAppendedV2() {
	end := f.size
	if f.v1 != nil {
		end -= int64(id3v1.Size)
	}
	if f.ape != nil {
		end = f.apeAt
	}
	if end < int64(id3v2.HeaderSize) {
		return
	}
	if f.detectSeekLinkedV2(end) {
		return
	}
	var foot [id3v2.HeaderSize]byte
	if _, err := f.src.ReadAt(foot[:], end-int64(id3v2.HeaderSize)); err != nil {
		return
	}
	if foot[0] != '3' || foot[1] != 'D' || foot[2] != 'I' {
		return
	}
	bodySize := int64(id3v2.DecodeSynchsafe(foot[6:10]))
	headerOffset := end - int64(id3v2.HeaderSize) - bodySize - int64(id3v2.HeaderSize)
	if headerOffset < 0 {
		return
	}
	tag, err := id3v2.ReadBounded(f.src, headerOffset, end-headerOffset)
	if err != nil {
		return
	}
	f.mergeDetectedV2(tag)
}

func (f *File) detectSeekLinkedV2(end int64) bool {
	if f.v2 == nil {
		return false
	}
	seek, ok := f.v2.Find(id3v2.FrameSEEK).(*id3v2.SeekFrame)
	if !ok {
		return false
	}
	base := f.v2at + f.v2size
	if f.v2.OriginalSize > 0 {
		base = f.v2at + f.v2.OriginalSize
	}
	next := base + int64(seek.Offset)
	if next <= base || next < 0 || next+int64(id3v2.HeaderSize) > end {
		return false
	}
	tag, err := id3v2.ReadBounded(f.src, next, end-next)
	if err != nil {
		return false
	}
	f.mergeDetectedV2(tag)
	return true
}

func (f *File) mergeDetectedV2(tag *id3v2.Tag) {
	if tag == nil {
		return
	}
	if f.v2 == nil || !tag.ExtendedHeader.Update {
		f.v2 = tag
	} else {
		f.v2.Merge(tag)
	}
	f.formats &^= FormatID3v2Any
	switch tag.Version {
	case 2:
		f.formats |= FormatID3v22
	case 3:
		f.formats |= FormatID3v23
	case 4:
		f.formats |= FormatID3v24
	}
}

// detectV1Footer scans for an ID3v1 footer and any APE trailer below it.
func (f *File) detectV1Footer() error {
	if f.size < int64(id3v1.Size) {
		return nil
	}
	t, err := id3v1.Read(f.src, f.size)
	v1Present := err == nil
	if v1Present {
		f.v1 = t
		f.formats |= FormatID3v1
	}
	apeEnd := f.size
	if v1Present {
		apeEnd -= int64(id3v1.Size)
	}
	_ = f.detectAPETail(apeEnd)
	if !v1Present && f.ape != nil {
		if t, err := id3v1.Read(f.src, f.apeAt); err == nil {
			f.v1 = t
			f.formats |= FormatID3v1
		}
	}
	return nil
}

// detectAPETail looks for an APE footer ending at end.
func (f *File) detectAPETail(end int64) error {
	tag, offset, err := ape.Read(f.src, end)
	if err != nil {
		return nil
	}
	f.ape = tag
	f.apeAt = offset
	f.apeLen = end - offset
	return nil
}

// detectFLAC reads the Vorbis Comment and picture blocks from FLAC.
func (f *File) detectFLAC(cfg openConfig) error {
	// Non-standard but common in the wild: some taggers prepend an
	// ID3v2 block to a FLAC stream. Parse that first so the
	// polymorphic Title/Artist/etc accessors return what the user
	// actually sees; then walk the FLAC blocks from past the ID3.
	flacOff := int64(0)
	var head [id3v2.HeaderSize]byte
	if _, err := f.src.ReadAt(head[:], 0); err == nil &&
		head[0] == 'I' && head[1] == 'D' && head[2] == '3' {
		if hdr, hErr := id3v2.ReadHeader(head[:]); hErr == nil {
			region := int64(id3v2.HeaderSize) + int64(hdr.Size)
			if hdr.Major == 4 && hdr.Flags&0x10 != 0 {
				region += int64(id3v2.HeaderSize)
			}
			if region < f.size {
				if tag, err := id3v2.ReadBounded(f.src, 0, region); err == nil {
					f.v2 = tag
					f.v2at = 0
					f.v2size = region
					switch tag.Version {
					case 2:
						f.formats |= FormatID3v22
					case 3:
						f.formats |= FormatID3v23
					case 4:
						f.formats |= FormatID3v24
					}
				}
				flacOff = region
			}
		}
	}
	src := f.src
	size := f.size
	if flacOff > 0 {
		src = offsetReaderAt{r: f.src, off: flacOff}
		size = f.size - flacOff
	}
	blocks, _, err := flac.ReadBlocksWithOptions(src, size, cfg.skipPictures)
	if err != nil {
		return nil
	}
	view := &flacView{}
	for _, b := range blocks {
		switch b.Type {
		case flac.BlockVorbisComment:
			vc, err := flac.DecodeVorbisCommentWithOptions(b.Body, cfg.skipPictures)
			if err == nil {
				view.comment = vc
			}
		case flac.BlockPicture:
			p, err := flac.DecodePicture(b.Body)
			if err == nil {
				view.pictures = append(view.pictures, p)
			}
		}
	}
	if view.comment != nil || len(view.pictures) > 0 {
		f.flac = view
	}
	return nil
}

// offsetReaderAt shifts every ReadAt by a constant offset, letting us
// reuse parsers that expect to start at byte 0 on files with a
// prepended ID3v2 region.
type offsetReaderAt struct {
	r   io.ReaderAt
	off int64
}

func (o offsetReaderAt) ReadAt(p []byte, off int64) (int, error) {
	return o.r.ReadAt(p, off+o.off)
}

// detectMP4 reads ilst items from MP4.
func (f *File) detectMP4(cfg openConfig) error {
	items, mdta, err := mp4.ReadMetadataWithOptions(f.src, f.size, cfg.skipPictures)
	if err != nil {
		return nil
	}
	if len(items) > 0 || len(mdta) > 0 {
		f.mp4 = &mp4View{items: items, mdta: mdta}
	}
	return nil
}

// detectOGG reads the Vorbis-style comment block from OGG.
func (f *File) detectOGG() error {
	return f.detectOGGWith(openConfig{})
}

func (f *File) detectOGGWith(cfg openConfig) error {
	f.oggErr = nil
	view, err := readOGGCommentsWithOptions(f.src, f.size, cfg.skipPictures)
	if err == nil && view != nil {
		f.flac = view
		return nil
	}
	if err != nil {
		f.oggErr = err
	}
	return nil
}

// detectV2InRange reads a single ID3v2 tag in a bounded region.
func (f *File) detectV2InRange(offset, maxSize int64) error {
	if maxSize < int64(id3v2.HeaderSize) {
		return nil
	}
	var head [id3v2.HeaderSize]byte
	if _, err := f.src.ReadAt(head[:], offset); err != nil {
		return nil
	}
	if head[0] != 'I' || head[1] != 'D' || head[2] != '3' {
		return nil
	}
	hdr, hErr := id3v2.ReadHeader(head[:])
	if hErr != nil {
		return nil
	}
	regionSize := int64(id3v2.HeaderSize) + int64(hdr.Size)
	if hdr.Major == 4 && hdr.Flags&0x10 != 0 {
		regionSize += int64(id3v2.HeaderSize)
	}
	if regionSize > maxSize {
		regionSize = maxSize
	}
	f.v2size = regionSize
	tag, perr := id3v2.ReadBounded(f.src, offset, maxSize)
	if perr != nil {
		f.v2corrupt = true
		return nil
	}
	f.v2 = tag
	f.v2at = offset
	switch tag.Version {
	case 2:
		f.formats |= FormatID3v22
	case 3:
		f.formats |= FormatID3v23
	case 4:
		f.formats |= FormatID3v24
	}
	return nil
}
