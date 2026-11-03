package mtag

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// saveRIFFContainer rewrites a WAV or AIFF file with the in-memory
// ID3v2 tag pasted into (or stripped from) its `id3 ` chunk. The
// outer RIFF/FORM byte size is recomputed and every other chunk is
// preserved byte-for-byte and in the original order.
//
// When the replacement tag fits the existing `id3 ` chunk and no
// native metadata (LIST-INFO / AIFF text) mutation is pending, the
// rewrite degrades to a single in-place WriteAt; otherwise it
// streams through a sibling temp file and ends with an atomic
// rename so the original is never half-written.
func (f *File) saveRIFFContainer() error {
	if f.container.Kind() != ContainerWAV && f.container.Kind() != ContainerAIFF {
		return fmt.Errorf("mtag: saveRIFFContainer called on %v", f.container.Kind())
	}

	// Encode the v2 tag (or nil, meaning "drop the id3 chunk").
	var tagBytes []byte
	if f.v2 != nil {
		body, err := f.v2.Encode(0)
		if err != nil {
			return err
		}
		tagBytes = body
	}

	var order binary.ByteOrder = binary.LittleEndian
	if f.container.info().byteOrder == orderBE {
		order = binary.BigEndian
	}

	// Fast path: patch the existing id3 chunk in place when the new
	// body fits and no native metadata chunks need to be regenerated.
	// File size, outer RIFF/FORM size, and every neighbouring chunk
	// stay on disk exactly as they were.
	info := f.container.info()
	nativeDirty := f.riffInfo != nil && f.riffInfo.dirty
	bwfDirty := f.bwf != nil && f.bwf.dirty
	chaptersDirty := f.chaptersDirty && f.container.Kind() == ContainerWAV
	if f.rw != nil && tagBytes != nil && !nativeDirty && !bwfDirty &&
		info.v2ChunkAt >= 0 && info.v2Bound > 0 &&
		int64(len(tagBytes)) <= info.v2Bound {
		pad := int(info.v2Bound - int64(len(tagBytes)))
		padded, err := f.v2.Encode(pad)
		if err != nil {
			return err
		}
		if int64(len(padded)) == info.v2Bound {
			if _, err := f.rw.WriteAt(padded, info.v2Offset); err != nil {
				return err
			}
			return nil
		}
	}

	chunks := listIFFChunks(f.src, f.size, order, info.outerMagic)

	// Build the new chunk list. Every chunk other than the id3
	// chunk and the native metadata chunks is copied through
	// verbatim. The id3 chunk is removed when tagBytes is nil;
	// otherwise it is rewritten or appended. WAV LIST-INFO and
	// AIFF text chunks (NAME/AUTH/ANNO/(c)) are regenerated from
	// f.riffInfo so polymorphic setters round-trip through the
	// native store too.
	type planned struct {
		id     [4]byte
		source *chunkSpan // nil means "synthetic, payload below"
		body   []byte     // populated only when source is nil
	}
	var plan []planned
	idChunkID := f.container.info().v2ChunkID
	if idChunkID == ([4]byte{}) {
		// New chunk: pick the spec-canonical spelling.
		switch f.container.Kind() {
		case ContainerWAV:
			idChunkID = [4]byte{'i', 'd', '3', ' '}
		default:
			idChunkID = [4]byte{'I', 'D', '3', ' '}
		}
	}
	// Decide whether to regenerate the native metadata chunks. We
	// only rebuild the LIST-INFO / AIFF text chunks when the in-memory
	// view was actually mutated; an untouched view passes through
	// byte-for-byte alongside the other chunks.
	regenNative := f.riffInfo != nil && f.riffInfo.dirty
	regenBWF := f.bwf != nil && f.bwf.dirty
	regenChapters := chaptersDirty
	isNativeChunk := func(c *chunkSpan) bool {
		if !regenNative {
			return false
		}
		switch f.container.Kind() {
		case ContainerWAV:
			if string(c.ID[:]) != "LIST" || c.DataSize < 4 {
				return false
			}
			var kind [4]byte
			if _, err := f.src.ReadAt(kind[:], c.DataAt); err != nil {
				return false
			}
			return string(kind[:]) == "INFO"
		case ContainerAIFF:
			switch string(c.ID[:]) {
			case "NAME", "AUTH", "ANNO", "\xa9   ":
				return true
			}
		}
		return false
	}
	isBWFChunk := func(c *chunkSpan) bool {
		if !regenBWF || f.container.Kind() != ContainerWAV {
			return false
		}
		switch string(c.ID[:]) {
		case riffBEXT, riffIXML, riffAXML, riffCART, riffUMID:
			return true
		}
		return false
	}
	isChapterChunk := func(c *chunkSpan) bool {
		if !regenChapters || f.container.Kind() != ContainerWAV {
			return false
		}
		switch string(c.ID[:]) {
		case "cue ":
			return true
		case "LIST":
			if c.DataSize < 4 {
				return false
			}
			var kind [4]byte
			if _, err := f.src.ReadAt(kind[:], c.DataAt); err != nil {
				return false
			}
			return string(kind[:]) == "adtl"
		}
		return false
	}
	wroteID3 := false
	wroteNative := false
	wroteBWF := false
	wroteChapters := false
	emitNative := func() {
		if !regenNative || wroteNative {
			return
		}
		wroteNative = true
		switch f.container.Kind() {
		case ContainerWAV:
			body := f.riffInfo.encodeWAVInfoList()
			if body == nil {
				return
			}
			plan = append(plan, planned{id: [4]byte{'L', 'I', 'S', 'T'}, body: body})
		case ContainerAIFF:
			for _, ch := range f.riffInfo.encodeAIFFTextChunks() {
				plan = append(plan, planned{id: ch.id, body: ch.body})
			}
		}
	}
	emitBWF := func() {
		if !regenBWF || wroteBWF {
			return
		}
		wroteBWF = true
		for _, ch := range f.bwf.encodeChunks() {
			plan = append(plan, planned{id: ch.id, body: ch.body})
		}
	}
	emitChapters := func() error {
		if !regenChapters || wroteChapters {
			return nil
		}
		wroteChapters = true
		cueBody, adtlBody, err := encodeWAVChapterChunks(f.chapters, f.AudioProperties().SampleRate)
		if err != nil {
			return err
		}
		if cueBody != nil {
			plan = append(plan, planned{id: [4]byte{'c', 'u', 'e', ' '}, body: cueBody})
		}
		if adtlBody != nil {
			plan = append(plan, planned{id: [4]byte{'L', 'I', 'S', 'T'}, body: adtlBody})
		}
		return nil
	}
	for i := range chunks {
		c := &chunks[i]
		if isRF64Magic(info.outerMagic) && string(c.ID[:]) == "ds64" {
			continue
		}
		if c.HeaderAt == f.container.info().v2ChunkAt {
			if tagBytes == nil {
				continue // drop
			}
			plan = append(plan, planned{id: idChunkID, body: tagBytes})
			wroteID3 = true
			continue
		}
		if isNativeChunk(c) {
			emitNative()
			continue
		}
		if isBWFChunk(c) {
			emitBWF()
			continue
		}
		if isChapterChunk(c) {
			if err := emitChapters(); err != nil {
				return err
			}
			continue
		}
		plan = append(plan, planned{id: c.ID, source: c})
	}
	if !wroteID3 && tagBytes != nil {
		plan = append(plan, planned{id: idChunkID, body: tagBytes})
	}
	// In case the source file had no pre-existing native / BWF
	// chunks, still append fresh ones from f.riffInfo / f.bwf.
	emitNative()
	emitBWF()
	if err := emitChapters(); err != nil {
		return err
	}

	// Compute the new outer size.
	var payloadLen int64 = 4 // wrapper kind ("WAVE" / "AIFF" / "AIFC")
	var rf64DataSize uint64
	rf64Extra := map[string]uint64{}
	for _, p := range plan {
		size := plannedSize(p)
		padded := size
		if padded%2 == 1 {
			padded++
		}
		payloadLen += 8 + padded
		if isRF64Magic(info.outerMagic) {
			name := string(p.id[:])
			switch {
			case name == "data":
				rf64DataSize = uint64(size)
			case size >= 1<<32:
				rf64Extra[name] = uint64(size)
			}
		}
	}
	bodyLen := payloadLen
	var ds64Body []byte
	if isRF64Magic(info.outerMagic) {
		ds64Body = renderRIFF64DS64(uint64(payloadLen)+28+8, rf64DataSize, rf64Extra)
		bodyLen += 8 + int64(len(ds64Body))
	}
	if !isRF64Magic(info.outerMagic) && bodyLen >= 1<<32 {
		return fmt.Errorf("mtag: rewritten RIFF would overflow 4-byte size field")
	}

	if f.path == "" {
		outerMagic := info.outerMagic
		if outerMagic == ([4]byte{}) {
			switch f.container.Kind() {
			case ContainerWAV:
				outerMagic = [4]byte{'R', 'I', 'F', 'F'}
			case ContainerAIFF:
				outerMagic = [4]byte{'F', 'O', 'R', 'M'}
			}
		}
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if _, err := tmp.Write(outerMagic[:]); err != nil {
				return err
			}
			var sizeBuf [4]byte
			if isRF64Magic(outerMagic) {
				order.PutUint32(sizeBuf[:], 0xFFFFFFFF)
			} else {
				order.PutUint32(sizeBuf[:], uint32(bodyLen))
			}
			if _, err := tmp.Write(sizeBuf[:]); err != nil {
				return err
			}
			if _, err := tmp.Write(f.container.info().wrapperKind[:]); err != nil {
				return err
			}
			if len(ds64Body) > 0 {
				if err := writeIFFChunk(tmp, [4]byte{'d', 's', '6', '4'}, ds64Body, order, false); err != nil {
					return err
				}
			}
			for _, p := range plan {
				if err := writePlannedIFFChunk(f, tmp, p, order, isRF64Magic(outerMagic)); err != nil {
					return err
				}
			}
			return nil
		})
	}

	// Stream to a temp file, then atomically rename over the
	// original. Crash-safe on every reasonable filesystem.
	tmp, tmpPath, err := f.createSiblingTemp()
	if err != nil {
		return err
	}
	modTime := f.pathModTime()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	// Outer header.
	outerMagic := info.outerMagic
	if outerMagic == ([4]byte{}) {
		switch f.container.Kind() {
		case ContainerWAV:
			outerMagic = [4]byte{'R', 'I', 'F', 'F'}
		case ContainerAIFF:
			outerMagic = [4]byte{'F', 'O', 'R', 'M'}
		}
	}
	if _, err := tmp.Write(outerMagic[:]); err != nil {
		cleanup()
		return err
	}
	var sizeBuf [4]byte
	if isRF64Magic(outerMagic) {
		order.PutUint32(sizeBuf[:], 0xFFFFFFFF)
	} else {
		order.PutUint32(sizeBuf[:], uint32(bodyLen))
	}
	if _, err := tmp.Write(sizeBuf[:]); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(f.container.info().wrapperKind[:]); err != nil {
		cleanup()
		return err
	}
	if len(ds64Body) > 0 {
		if err := writeIFFChunk(tmp, [4]byte{'d', 's', '6', '4'}, ds64Body, order, false); err != nil {
			cleanup()
			return err
		}
	}

	// Chunks.
	for _, p := range plan {
		if err := writePlannedIFFChunk(f, tmp, p, order, isRF64Magic(outerMagic)); err != nil {
			cleanup()
			return err
		}
	}

	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	// Close the existing handle so rename can replace it on Windows.
	_ = f.fd.Close()
	f.fd = nil

	if err := os.Rename(tmpPath, f.path); err != nil {
		if renameBlockedByReader(err) {
			if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
				return nil
			}
		}
		_ = os.Remove(tmpPath)
		// Best-effort re-open of the original handle.
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
	stat, err := reopen.Stat()
	if err != nil {
		return err
	}
	f.size = stat.Size()
	return nil
}

func plannedSize(p struct {
	id     [4]byte
	source *chunkSpan
	body   []byte
}) int64 {
	if p.source != nil {
		return p.source.DataSize
	}
	return int64(len(p.body))
}

func writePlannedIFFChunk(f *File, w io.Writer, p struct {
	id     [4]byte
	source *chunkSpan
	body   []byte
}, order binary.ByteOrder, rf64 bool) error {
	size := plannedSize(p)
	writeRF64Placeholder := rf64 && string(p.id[:]) == "data"
	if err := writeIFFChunkHeader(w, p.id, size, order, writeRF64Placeholder); err != nil {
		return err
	}
	if p.source != nil {
		if err := copyRangeCtx(f.saveCtx, w, f.src, p.source.DataAt, p.source.DataSize); err != nil {
			return err
		}
	} else {
		if _, err := w.Write(p.body); err != nil {
			return err
		}
	}
	if size%2 == 1 {
		if _, err := w.Write([]byte{0}); err != nil {
			return err
		}
	}
	return nil
}

func writeIFFChunk(w io.Writer, id [4]byte, body []byte, order binary.ByteOrder, sizeAsMax32 bool) error {
	if err := writeIFFChunkHeader(w, id, int64(len(body)), order, sizeAsMax32); err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := w.Write(body); err != nil {
			return err
		}
	}
	if len(body)%2 == 1 {
		if _, err := w.Write([]byte{0}); err != nil {
			return err
		}
	}
	return nil
}

func writeIFFChunkHeader(w io.Writer, id [4]byte, size int64, order binary.ByteOrder, sizeAsMax32 bool) error {
	var hdr [8]byte
	copy(hdr[:4], id[:])
	if sizeAsMax32 {
		order.PutUint32(hdr[4:8], 0xFFFFFFFF)
	} else {
		order.PutUint32(hdr[4:8], uint32(size))
	}
	_, err := w.Write(hdr[:])
	return err
}

func encodeWAVChapterChunks(chapters []Chapter, sampleRate int) (cueBody, adtlBody []byte, err error) {
	if len(chapters) == 0 {
		return nil, nil, nil
	}
	if sampleRate <= 0 {
		return nil, nil, fmt.Errorf("mtag: WAV chapter write needs a positive sample rate")
	}
	var cue bytes.Buffer
	var u32 [4]byte
	binary.LittleEndian.PutUint32(u32[:], uint32(len(chapters)))
	cue.Write(u32[:])
	var adtl bytes.Buffer
	adtl.WriteString("adtl")
	for i, ch := range chapters {
		id := uint32(i + 1)
		if n, _ := strconv.Atoi(strings.TrimSpace(ch.ID)); n > 0 {
			id = uint32(n)
		}
		startSamples := uint32((maxDuration(ch.Start, 0) * time.Duration(sampleRate)) / time.Second)
		binary.LittleEndian.PutUint32(u32[:], id)
		cue.Write(u32[:])
		binary.LittleEndian.PutUint32(u32[:], 0)
		cue.Write(u32[:])
		cue.WriteString("data")
		binary.LittleEndian.PutUint32(u32[:], 0)
		cue.Write(u32[:])
		binary.LittleEndian.PutUint32(u32[:], 0)
		cue.Write(u32[:])
		binary.LittleEndian.PutUint32(u32[:], startSamples)
		cue.Write(u32[:])
		if ch.Title != "" {
			adtl.WriteString("labl")
			size := 4 + len(ch.Title) + 1
			binary.LittleEndian.PutUint32(u32[:], uint32(size))
			adtl.Write(u32[:])
			binary.LittleEndian.PutUint32(u32[:], id)
			adtl.Write(u32[:])
			adtl.WriteString(ch.Title)
			adtl.WriteByte(0)
			if size%2 == 1 {
				adtl.WriteByte(0)
			}
		}
	}
	cueBody = cue.Bytes()
	if adtl.Len() > 4 {
		adtlBody = adtl.Bytes()
	}
	return cueBody, adtlBody, nil
}
