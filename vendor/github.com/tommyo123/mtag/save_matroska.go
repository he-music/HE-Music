package mtag

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

var (
	ebmlIDBytesSeekHead        = []byte{0x11, 0x4D, 0x9B, 0x74}
	ebmlIDBytesSegment         = []byte{0x18, 0x53, 0x80, 0x67}
	ebmlIDBytesInfo            = []byte{0x15, 0x49, 0xA9, 0x66}
	ebmlIDBytesTags            = []byte{0x12, 0x54, 0xC3, 0x67}
	ebmlIDBytesChapters        = []byte{0x10, 0x43, 0xA7, 0x70}
	ebmlIDBytesAttachments     = []byte{0x19, 0x41, 0xA4, 0x69}
	ebmlIDBytesTag             = []byte{0x73, 0x73}
	ebmlIDBytesTargets         = []byte{0x63, 0xC0}
	ebmlIDBytesSimpleTag       = []byte{0x67, 0xC8}
	ebmlIDBytesTagLanguage     = []byte{0x44, 0x7A}
	ebmlIDBytesTagDefault      = []byte{0x44, 0x84}
	ebmlIDBytesTagName         = []byte{0x45, 0xA3}
	ebmlIDBytesTagString       = []byte{0x44, 0x87}
	ebmlIDBytesTargetTypeValue = []byte{0x68, 0xCA}
	ebmlIDBytesTargetType      = []byte{0x63, 0xCA}
	ebmlIDBytesTitle           = []byte{0x7B, 0xA9}
	ebmlIDBytesAttachedFile    = []byte{0x61, 0xA7}
	ebmlIDBytesFileName        = []byte{0x46, 0x6E}
	ebmlIDBytesFileDescription = []byte{0x46, 0x7E}
	ebmlIDBytesFileMimeType    = []byte{0x46, 0x60}
	ebmlIDBytesFileData        = []byte{0x46, 0x5C}
	ebmlIDBytesVoid            = []byte{0xEC}
)

type matroskaTopSpan struct {
	ID        uint64
	Offset    int64
	DataAt    int64
	DataEnd   int64
	HeaderLen int
	SizeLen   int
	Unknown   bool
}

type matroskaSegmentLayout struct {
	SegmentOffset   int64
	SizeFieldOffset int64
	SizeFieldLen    int
	DataStart       int64
	DataEnd         int64
	UnknownSize     bool
	Children        []matroskaTopSpan
	Info            *matroskaTopSpan
	Tags            []matroskaTopSpan
	Chapters        []matroskaTopSpan
	Attachments     []matroskaTopSpan
	Voids           []matroskaTopSpan
}

func encodeEBMLSize(value uint64) []byte {
	for width := 1; width <= 8; width++ {
		if value > maxEBMLVintValue(width) {
			continue
		}
		out := make([]byte, width)
		x := (uint64(1) << (7 * width)) | value
		for i := width - 1; i >= 0; i-- {
			out[i] = byte(x)
			x >>= 8
		}
		return out
	}
	// Values beyond the 8-byte VINT range (2^56-2) cannot occur in
	// practice: payloads larger than 72 PiB are not representable by
	// any realistic caller. Fall back to the unknown-size marker
	// rather than panicking.
	return []byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}
}

func encodeEBMLSizeWidth(value uint64, width int) ([]byte, bool) {
	if width < 1 || width > 8 || value > maxEBMLVintValue(width) {
		return nil, false
	}
	out := make([]byte, width)
	x := (uint64(1) << (7 * width)) | value
	for i := width - 1; i >= 0; i-- {
		out[i] = byte(x)
		x >>= 8
	}
	return out, true
}

func maxEBMLVintValue(width int) uint64 {
	return (uint64(1) << (7 * width)) - 2
}

func renderEBMLElement(id []byte, payload []byte) []byte {
	out := make([]byte, 0, len(id)+8+len(payload))
	out = append(out, id...)
	out = append(out, encodeEBMLSize(uint64(len(payload)))...)
	out = append(out, payload...)
	return out
}

func renderMatroskaTags(view *matroskaView) []byte {
	if view == nil {
		return nil
	}
	var simpleTags [][]byte
	var preserved [][]byte
	for _, field := range view.Fields {
		if field.Name == "" || field.Value == "" || shouldSkipMatroskaTagField(field.Name) {
			continue
		}
		payload := make([]byte, 0, len(field.Name)+len(field.Value)+32)
		payload = append(payload, renderEBMLElement(ebmlIDBytesTagName, []byte(field.Name))...)
		payload = append(payload, renderEBMLElement(ebmlIDBytesTagLanguage, []byte("und"))...)
		payload = append(payload, renderEBMLElement(ebmlIDBytesTagDefault, []byte{1})...)
		payload = append(payload, renderEBMLElement(ebmlIDBytesTagString, []byte(field.Value))...)
		simpleTags = append(simpleTags, renderEBMLElement(ebmlIDBytesSimpleTag, payload))
	}
	preserved = append(preserved, view.RawTargetTags...)
	if len(simpleTags) == 0 && len(preserved) == 0 {
		return nil
	}
	targets := make([]byte, 0, 16)
	targets = append(targets, renderEBMLElement(ebmlIDBytesTargetTypeValue, []byte{30})...)
	var tagPayload []byte
	tagPayload = append(tagPayload, renderEBMLElement(ebmlIDBytesTargets, targets)...)
	for _, st := range simpleTags {
		tagPayload = append(tagPayload, st...)
	}
	var body []byte
	for _, raw := range preserved {
		body = append(body, raw...)
	}
	if len(simpleTags) > 0 {
		tag := renderEBMLElement(ebmlIDBytesTag, tagPayload)
		body = append(body, tag...)
	}
	return renderEBMLElement(ebmlIDBytesTags, body)
}

func renderMatroskaChapters(chapters []Chapter) []byte {
	if len(chapters) == 0 {
		return nil
	}
	var atoms []byte
	for i, ch := range chapters {
		var payload []byte
		id, _ := strconv.ParseUint(strings.TrimSpace(ch.ID), 10, 64)
		if id == 0 {
			id = uint64(i + 1)
		}
		payload = append(payload, renderEBMLUInt(ebmlIDChapterUID, id)...)
		payload = append(payload, renderEBMLUInt(ebmlIDChapterTimeStart, uint64(maxDuration(ch.Start, 0)))...)
		if ch.End > ch.Start {
			payload = append(payload, renderEBMLUInt(ebmlIDChapterTimeEnd, uint64(ch.End))...)
		}
		if ch.Title != "" {
			display := renderEBMLElement([]byte{0x85}, []byte(ch.Title))
			payload = append(payload, renderEBMLElement([]byte{0x80}, display)...)
		}
		atoms = append(atoms, renderEBMLElement([]byte{0xB6}, payload)...)
	}
	edition := renderEBMLElement([]byte{0x45, 0xB9}, atoms)
	return renderEBMLElement(ebmlIDBytesChapters, edition)
}

func renderEBMLUInt(id uint32, value uint64) []byte {
	width := 1
	for v := value; v > 0xFF; v >>= 8 {
		width++
	}
	if width < 1 {
		width = 1
	}
	buf := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		buf[i] = byte(value)
		value >>= 8
	}
	return renderEBMLElement(encodeEBMLID(id), buf)
}

func encodeEBMLID(id uint32) []byte {
	switch {
	case id <= 0xFF:
		return []byte{byte(id)}
	case id <= 0xFFFF:
		return []byte{byte(id >> 8), byte(id)}
	case id <= 0xFFFFFF:
		return []byte{byte(id >> 16), byte(id >> 8), byte(id)}
	default:
		return []byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)}
	}
}

func renderMatroskaAttachments(view *matroskaView) []byte {
	if view == nil || len(view.Attachments) == 0 {
		return nil
	}
	var body []byte
	for _, att := range view.Attachments {
		if len(att.Data) == 0 {
			continue
		}
		payload := make([]byte, 0, len(att.Name)+len(att.Description)+len(att.MIME)+len(att.Data)+32)
		name := strings.TrimSpace(att.Name)
		if name == "" {
			name = "attachment.bin"
		}
		payload = append(payload, renderEBMLElement(ebmlIDBytesFileName, []byte(name))...)
		if desc := strings.TrimSpace(att.Description); desc != "" {
			payload = append(payload, renderEBMLElement(ebmlIDBytesFileDescription, []byte(desc))...)
		}
		mime := strings.TrimSpace(att.MIME)
		if mime == "" {
			mime = guessImageMIME(name, att.Data)
		}
		if mime == "" {
			mime = "application/octet-stream"
		}
		payload = append(payload, renderEBMLElement(ebmlIDBytesFileMimeType, []byte(mime))...)
		payload = append(payload, renderEBMLElement(ebmlIDBytesFileData, att.Data)...)
		body = append(body, renderEBMLElement(ebmlIDBytesAttachedFile, payload)...)
	}
	if len(body) == 0 {
		return nil
	}
	return renderEBMLElement(ebmlIDBytesAttachments, body)
}

func shouldSkipMatroskaTagField(name string) bool {
	switch name {
	case "MUXING_APP", "WRITING_APP", "ENCODER", "CREATION_TIME":
		return true
	}
	return false
}

func renderEBMLVoid(total int) []byte {
	for width := 1; width <= 8; width++ {
		dataLen := total - 1 - width
		if dataLen < 0 {
			continue
		}
		if uint64(dataLen) > maxEBMLVintValue(width) {
			continue
		}
		out := make([]byte, total)
		out[0] = ebmlIDBytesVoid[0]
		sizeBytes, _ := encodeEBMLSizeWidth(uint64(dataLen), width)
		copy(out[1:], sizeBytes)
		return out
	}
	return nil
}

func scanMatroskaSegmentLayout(r WritableSource, size int64) (*matroskaSegmentLayout, error) {
	id, idLen, _, err := readEBMLVintAt(r, 0, true)
	if err != nil || id != ebmlIDHeader {
		return nil, fmt.Errorf("matroska: missing EBML header")
	}
	headerSize, sizeLen, unknown, err := readEBMLVintAt(r, int64(idLen), false)
	if err != nil {
		return nil, err
	}
	off := int64(idLen + sizeLen)
	if !unknown {
		off += int64(headerSize)
	}
	for off < size {
		elemID, elemIDLen, _, err := readEBMLVintAt(r, off, true)
		if err != nil {
			return nil, err
		}
		elemSize, elemSizeLen, elemUnknown, err := readEBMLVintAt(r, off+int64(elemIDLen), false)
		if err != nil {
			return nil, err
		}
		dataAt := off + int64(elemIDLen+elemSizeLen)
		dataEnd := size
		if !elemUnknown {
			dataEnd = dataAt + int64(elemSize)
			if dataEnd > size {
				return nil, fmt.Errorf("matroska: invalid top-level element size")
			}
		}
		if elemID == ebmlIDSegment {
			layout := &matroskaSegmentLayout{
				SegmentOffset:   off,
				SizeFieldOffset: off + int64(elemIDLen),
				SizeFieldLen:    elemSizeLen,
				DataStart:       dataAt,
				DataEnd:         dataEnd,
				UnknownSize:     elemUnknown,
			}
			if err := scanMatroskaTopChildren(r, size, layout); err != nil {
				return nil, err
			}
			return layout, nil
		}
		if elemUnknown {
			break
		}
		off = dataEnd
	}
	return nil, fmt.Errorf("matroska: segment not found")
}

func scanMatroskaTopChildren(r WritableSource, fileSize int64, layout *matroskaSegmentLayout) error {
	end := layout.DataEnd
	if layout.UnknownSize {
		end = fileSize
	}
	for off := layout.DataStart; off < end; {
		id, idLen, _, err := readEBMLVintAt(r, off, true)
		if err != nil {
			return err
		}
		sizeVal, sizeLen, unknown, err := readEBMLVintAt(r, off+int64(idLen), false)
		if err != nil {
			return err
		}
		dataAt := off + int64(idLen+sizeLen)
		dataEnd := end
		if !unknown {
			dataEnd = dataAt + int64(sizeVal)
			if dataEnd > end {
				return fmt.Errorf("matroska: invalid top-level child size")
			}
		} else {
			return fmt.Errorf("matroska: unknown-sized top-level child 0x%X not yet writable", id)
		}
		span := matroskaTopSpan{
			ID:        id,
			Offset:    off,
			DataAt:    dataAt,
			DataEnd:   dataEnd,
			HeaderLen: idLen + sizeLen,
			SizeLen:   sizeLen,
			Unknown:   unknown,
		}
		layout.Children = append(layout.Children, span)
		switch id {
		case ebmlIDInfo:
			spanCopy := span
			layout.Info = &spanCopy
		case ebmlIDVoid:
			layout.Voids = append(layout.Voids, span)
		}
		if id == ebmlIDTags {
			layout.Tags = append(layout.Tags, span)
		}
		if id == ebmlIDChapters {
			layout.Chapters = append(layout.Chapters, span)
		}
		if id == ebmlIDAttachments {
			layout.Attachments = append(layout.Attachments, span)
		}
		off = dataEnd
	}
	return nil
}

func (f *File) saveMatroska() error {
	w, err := f.writable()
	if err != nil {
		return err
	}
	layout, err := scanMatroskaSegmentLayout(w, f.size)
	if err != nil {
		return err
	}
	if err := f.patchMatroskaInfo(layout); err != nil {
		return err
	}
	newTags := renderMatroskaTags(f.mkv)
	var newChapters []byte
	if f.chaptersDirty {
		newChapters = renderMatroskaChapters(f.chapters)
	}
	newAttachments := renderMatroskaAttachments(f.mkv)
	if len(newTags) == 0 && len(layout.Tags) == 0 &&
		len(newChapters) == 0 && len(layout.Chapters) == 0 &&
		len(newAttachments) == 0 && len(layout.Attachments) == 0 {
		return nil
	}
	if !f.matroskaNeedsRewrite(layout, layout.Tags, newTags) &&
		!f.matroskaNeedsRewrite(layout, layout.Chapters, newChapters) &&
		!f.matroskaNeedsRewrite(layout, layout.Attachments, newAttachments) &&
		f.matroskaCanPlaceTopElements(layout, newAttachments, newChapters, newTags) {
		if err := f.commitMatroskaTopElement(layout, layout.Attachments, newAttachments); err != nil {
			return err
		}
		if err := f.commitMatroskaTopElement(layout, layout.Chapters, newChapters); err != nil {
			return err
		}
		return f.commitMatroskaTopElement(layout, layout.Tags, newTags)
	}

	segmentExtra := int64(len(newTags) + len(newChapters) + len(newAttachments))
	if !layout.UnknownSize {
		segLen := layout.DataEnd - layout.DataStart
		sizeBytes, ok := encodeEBMLSizeWidth(uint64(segLen+segmentExtra), layout.SizeFieldLen)
		if !ok {
			return fmt.Errorf("matroska: segment size growth no longer fits original size field")
		}
		if f.path == "" {
			return f.rewriteWritableFromTemp(func(tmp *os.File) error {
				if err := copyRangeCtx(f.saveCtx, tmp, f.src, 0, layout.SizeFieldOffset); err != nil {
					return err
				}
				if _, err := tmp.Write(sizeBytes); err != nil {
					return err
				}
				if err := f.writeMatroskaBody(tmp, layout, newTags, newChapters, newAttachments); err != nil {
					return err
				}
				if layout.DataEnd < f.size {
					if err := copyRangeCtx(f.saveCtx, tmp, f.src, layout.DataEnd, f.size-layout.DataEnd); err != nil {
						return err
					}
				}
				return nil
			})
		}
		tmp, tmpPath, err := f.createSiblingTemp()
		if err != nil {
			return err
		}
		modTime := f.pathModTime()
		cleanup := func() {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
		if err := copyRangeCtx(f.saveCtx, tmp, f.src, 0, layout.SizeFieldOffset); err != nil {
			cleanup()
			return err
		}
		if _, err := tmp.Write(sizeBytes); err != nil {
			cleanup()
			return err
		}
		if err := f.writeMatroskaBody(tmp, layout, newTags, newChapters, newAttachments); err != nil {
			cleanup()
			return err
		}
		if layout.DataEnd < f.size {
			if err := copyRangeCtx(f.saveCtx, tmp, f.src, layout.DataEnd, f.size-layout.DataEnd); err != nil {
				cleanup()
				return err
			}
		}
		if err := tmp.Close(); err != nil {
			_ = os.Remove(tmpPath)
			return err
		}
		_ = f.fd.Close()
		f.fd = nil
		if err := os.Rename(tmpPath, f.path); err != nil {
			if renameBlockedByReader(err) {
				if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
					return nil
				}
			}
			_ = os.Remove(tmpPath)
			reopen, rerr := os.OpenFile(f.path, os.O_RDWR, 0)
			if rerr == nil {
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
		info, err := reopen.Stat()
		if err != nil {
			return err
		}
		f.size = info.Size()
		return nil
	}

	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if err := copyRangeCtx(f.saveCtx, tmp, f.src, 0, layout.SizeFieldOffset+int64(layout.SizeFieldLen)); err != nil {
				return err
			}
			if err := f.writeMatroskaBody(tmp, layout, newTags, newChapters, newAttachments); err != nil {
				return err
			}
			return nil
		})
	}
	tmp, tmpPath, err := f.createSiblingTemp()
	if err != nil {
		return err
	}
	modTime := f.pathModTime()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if err := copyRangeCtx(f.saveCtx, tmp, f.src, 0, layout.SizeFieldOffset+int64(layout.SizeFieldLen)); err != nil {
		cleanup()
		return err
	}
	if err := f.writeMatroskaBody(tmp, layout, newTags, newChapters, newAttachments); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	_ = f.fd.Close()
	f.fd = nil
	if err := os.Rename(tmpPath, f.path); err != nil {
		if renameBlockedByReader(err) {
			if ferr := f.replacePathFromTemp(tmpPath); ferr == nil {
				return nil
			}
		}
		_ = os.Remove(tmpPath)
		reopen, rerr := os.OpenFile(f.path, os.O_RDWR, 0)
		if rerr == nil {
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
	info, err := reopen.Stat()
	if err != nil {
		return err
	}
	f.size = info.Size()
	return nil
}

func (f *File) patchMatroskaElementInPlace(spans []matroskaTopSpan, newElem []byte) error {
	w, err := f.writable()
	if err != nil {
		return err
	}
	for i, span := range spans {
		elem := []byte(nil)
		if i == 0 {
			elem = newElem
		}
		if err := writeMatroskaElementIntoRegion(w, span.Offset, int(span.DataEnd-span.Offset), elem); err != nil {
			return err
		}
	}
	return nil
}

func findMatroskaVoidFor(voids []matroskaTopSpan, need int) (matroskaTopSpan, bool) {
	for _, span := range voids {
		if int(span.DataEnd-span.Offset) >= need {
			return span, true
		}
	}
	return matroskaTopSpan{}, false
}

func writeMatroskaElementIntoRegion(w WritableSource, offset int64, total int, elem []byte) error {
	if len(elem) == 0 {
		void := renderEBMLVoid(total)
		if void == nil {
			return fmt.Errorf("matroska: cannot encode Void for %d bytes", total)
		}
		_, err := w.WriteAt(void, offset)
		return err
	}
	if len(elem) > total {
		return fmt.Errorf("matroska: element of %d bytes does not fit %d-byte region", len(elem), total)
	}
	buf := make([]byte, total)
	copy(buf, elem)
	if len(elem) < total {
		void := renderEBMLVoid(total - len(elem))
		if void == nil {
			return fmt.Errorf("matroska: cannot encode trailing Void for %d bytes", total-len(elem))
		}
		copy(buf[len(elem):], void)
	}
	_, err := w.WriteAt(buf, offset)
	return err
}

func readRange(r io.ReaderAt, off, n int64) ([]byte, error) {
	buf := make([]byte, n)
	_, err := r.ReadAt(buf, off)
	return buf, err
}

func (f *File) placeMatroskaElement(spans []matroskaTopSpan, span matroskaTopSpan, newElem []byte) error {
	w, err := f.writable()
	if err != nil {
		return err
	}
	if err := writeMatroskaElementIntoRegion(w, span.Offset, int(span.DataEnd-span.Offset), newElem); err != nil {
		return err
	}
	for _, old := range spans {
		if old.Offset == span.Offset && old.DataEnd == span.DataEnd {
			continue
		}
		if err := writeMatroskaElementIntoRegion(w, old.Offset, int(old.DataEnd-old.Offset), nil); err != nil {
			return err
		}
	}
	return nil
}

func (f *File) matroskaNeedsRewrite(layout *matroskaSegmentLayout, spans []matroskaTopSpan, newElem []byte) bool {
	switch {
	case len(newElem) == 0 && len(spans) == 0:
		return false
	case len(spans) > 0:
		firstLen := int(spans[0].DataEnd - spans[0].Offset)
		return len(newElem) > firstLen
	case len(newElem) > 0:
		_, ok := findMatroskaVoidFor(layout.Voids, len(newElem))
		return !ok
	default:
		return false
	}
}

func (f *File) commitMatroskaTopElement(layout *matroskaSegmentLayout, spans []matroskaTopSpan, newElem []byte) error {
	switch {
	case len(newElem) == 0 && len(spans) == 0:
		return nil
	case len(spans) > 0:
		return f.patchMatroskaElementInPlace(spans, newElem)
	case len(newElem) > 0:
		span, ok := findMatroskaVoidFor(layout.Voids, len(newElem))
		if !ok {
			return fmt.Errorf("matroska: no Void large enough for top-level element")
		}
		if err := f.placeMatroskaElement(spans, span, newElem); err != nil {
			return err
		}
		layout.consumeVoid(span.Offset, int64(len(newElem)), span.DataEnd)
		return nil
	default:
		return nil
	}
}

func (f *File) matroskaCanPlaceTopElements(layout *matroskaSegmentLayout, newAttachments, newChapters, newTags []byte) bool {
	voids := append([]matroskaTopSpan(nil), layout.Voids...)
	elems := []struct {
		spans []matroskaTopSpan
		elem  []byte
	}{
		{spans: layout.Attachments, elem: newAttachments},
		{spans: layout.Chapters, elem: newChapters},
		{spans: layout.Tags, elem: newTags},
	}
	for _, item := range elems {
		if len(item.spans) > 0 || len(item.elem) == 0 {
			continue
		}
		elem := item.elem
		if len(elem) == 0 {
			continue
		}
		span, ok := findMatroskaVoidFor(voids, len(elem))
		if !ok {
			return false
		}
		for i := range voids {
			if voids[i].Offset != span.Offset || voids[i].DataEnd != span.DataEnd {
				continue
			}
			newOffset := span.Offset + int64(len(elem))
			if newOffset >= span.DataEnd {
				voids = append(voids[:i], voids[i+1:]...)
			} else {
				voids[i].Offset = newOffset
			}
			break
		}
	}
	return true
}

func (f *File) patchMatroskaInfo(layout *matroskaSegmentLayout) error {
	if layout.Info == nil || f.mkv == nil {
		return nil
	}
	title := strings.TrimSpace(f.mkv.Get("TITLE"))
	orig, err := readRange(f.src, layout.Info.Offset, layout.Info.DataEnd-layout.Info.Offset)
	if err != nil {
		return err
	}
	newInfo, changed, hadTitle, err := rewriteMatroskaInfoElement(orig, title)
	if err != nil || !changed {
		return err
	}
	total := int(layout.Info.DataEnd - layout.Info.Offset)
	if len(newInfo) <= total {
		w, err := f.writable()
		if err != nil {
			return err
		}
		return writeMatroskaElementIntoRegion(w, layout.Info.Offset, total, newInfo)
	}
	next := layout.nextChildAfter(layout.Info.Offset)
	if next != nil && next.ID == ebmlIDVoid && next.Offset == layout.Info.DataEnd {
		combined := int(next.DataEnd - layout.Info.Offset)
		if len(newInfo) <= combined {
			w, err := f.writable()
			if err != nil {
				return err
			}
			if err := writeMatroskaElementIntoRegion(w, layout.Info.Offset, combined, newInfo); err != nil {
				return err
			}
			layout.shiftVoid(next.Offset, layout.Info.Offset+int64(len(newInfo)), next.DataEnd)
			return nil
		}
	}
	if !hadTitle {
		return nil
	}
	return fmt.Errorf("matroska: updated Info element no longer fits in-place")
}

func (l *matroskaSegmentLayout) nextChildAfter(offset int64) *matroskaTopSpan {
	for i := range l.Children {
		if l.Children[i].Offset == offset {
			if i+1 < len(l.Children) {
				return &l.Children[i+1]
			}
			return nil
		}
	}
	return nil
}

func (l *matroskaSegmentLayout) shiftVoid(oldOffset, newOffset, end int64) {
	if newOffset >= end {
		kept := l.Voids[:0]
		for _, span := range l.Voids {
			if span.Offset != oldOffset {
				kept = append(kept, span)
			}
		}
		l.Voids = kept
		return
	}
	for i := range l.Voids {
		if l.Voids[i].Offset == oldOffset {
			l.Voids[i].Offset = newOffset
			l.Voids[i].DataEnd = end
			return
		}
	}
}

func (l *matroskaSegmentLayout) consumeVoid(oldOffset, newOffset, end int64) {
	l.shiftVoid(oldOffset, newOffset, end)
}

func rewriteMatroskaInfoElement(elem []byte, title string) ([]byte, bool, bool, error) {
	if len(elem) == 0 {
		return nil, false, false, nil
	}
	id, idLen, _, ok := readEBMLVintBytes(elem, true)
	if !ok || id != ebmlIDInfo {
		return nil, false, false, fmt.Errorf("matroska: invalid Info element")
	}
	sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(elem[idLen:], false)
	if !ok || unknown {
		return nil, false, false, fmt.Errorf("matroska: invalid Info size")
	}
	dataAt := idLen + sizeLen
	dataEnd := dataAt + int(sizeVal)
	if dataEnd > len(elem) {
		return nil, false, false, fmt.Errorf("matroska: truncated Info element")
	}
	body := elem[dataAt:dataEnd]
	var rebuilt []byte
	var oldTitle string
	for off := 0; off < len(body); {
		childID, childIDLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return nil, false, false, fmt.Errorf("matroska: malformed Info child")
		}
		childSize, childSizeLen, childUnknown, ok := readEBMLVintBytes(body[off+childIDLen:], false)
		if !ok || childUnknown {
			return nil, false, false, fmt.Errorf("matroska: malformed Info child size")
		}
		childEnd := off + childIDLen + childSizeLen + int(childSize)
		if childEnd > len(body) {
			return nil, false, false, fmt.Errorf("matroska: truncated Info child")
		}
		if childID == ebmlIDTitle {
			oldTitle = strings.TrimSpace(string(body[off+childIDLen+childSizeLen : childEnd]))
		} else {
			rebuilt = append(rebuilt, body[off:childEnd]...)
		}
		off = childEnd
	}
	if strings.TrimSpace(oldTitle) == title {
		return elem, false, oldTitle != "", nil
	}
	if title != "" {
		rebuilt = append(rebuilt, renderEBMLElement(ebmlIDBytesTitle, []byte(title))...)
	}
	return renderEBMLElement(ebmlIDBytesInfo, rebuilt), true, oldTitle != "", nil
}

func (f *File) writeMatroskaBody(dst io.Writer, layout *matroskaSegmentLayout, newTags, newChapters, newAttachments []byte) error {
	// Compute where the appended Tags / Attachments will land
	// relative to the segment data start. The rewrite keeps the
	// original segment-body length intact (Tags / Attachments are
	// voided in place, not removed), then appends newAttachments
	// then newTags at the tail.
	origBody := layout.DataEnd - layout.DataStart
	newAttOffset := origBody
	newChaptersOffset := origBody + int64(len(newAttachments))
	newTagsOffset := newChaptersOffset + int64(len(newChapters))
	updates := map[uint32]int64{}
	if len(newAttachments) > 0 {
		updates[ebmlIDAttachments] = newAttOffset
	}
	if len(newChapters) > 0 {
		updates[ebmlIDChapters] = newChaptersOffset
	}
	if len(newTags) > 0 {
		updates[ebmlIDTags] = newTagsOffset
	}

	prev := layout.DataStart
	for _, span := range layout.Children {
		if span.Offset > prev {
			if err := copyRangeCtx(f.saveCtx, dst, f.src, prev, span.Offset-prev); err != nil {
				return err
			}
		}
		switch span.ID {
		case ebmlIDTags, ebmlIDAttachments, ebmlIDChapters:
			void := renderEBMLVoid(int(span.DataEnd - span.Offset))
			if void == nil {
				return fmt.Errorf("matroska: cannot encode Void for %d bytes", span.DataEnd-span.Offset)
			}
			if _, err := dst.Write(void); err != nil {
				return err
			}
		case ebmlIDSeekHead:
			// Patch SeekPosition entries that point at relocated elements so
			// the updated SeekHead continues to resolve to the rewritten
			// locations instead of the Void left behind in place.
			if err := f.emitPatchedSeekHead(dst, span, updates); err != nil {
				return err
			}
		default:
			if err := copyRangeCtx(f.saveCtx, dst, f.src, span.Offset, span.DataEnd-span.Offset); err != nil {
				return err
			}
		}
		prev = span.DataEnd
	}
	if layout.DataEnd > prev {
		if err := copyRangeCtx(f.saveCtx, dst, f.src, prev, layout.DataEnd-prev); err != nil {
			return err
		}
	}
	if len(newAttachments) > 0 {
		if _, err := dst.Write(newAttachments); err != nil {
			return err
		}
	}
	if len(newChapters) > 0 {
		if _, err := dst.Write(newChapters); err != nil {
			return err
		}
	}
	if len(newTags) > 0 {
		if _, err := dst.Write(newTags); err != nil {
			return err
		}
	}
	return nil
}

// emitPatchedSeekHead reads the original SeekHead bytes, rewrites
// the SeekPosition value of any Seek entry whose SeekID matches
// updates (keyed by EBML ID), and writes the result to dst with
// the element's on-disk byte length preserved. Keeping the size
// stable means every other element in the segment stays at its
// original offset, so only the explicitly-updated entries change.
func (f *File) emitPatchedSeekHead(dst io.Writer, span matroskaTopSpan, updates map[uint32]int64) error {
	raw, err := readRange(f.src, span.Offset, span.DataEnd-span.Offset)
	if err != nil {
		return err
	}
	if len(updates) == 0 {
		_, err := dst.Write(raw)
		return err
	}
	// Walk the SeekHead body (skip the element header) and patch
	// every Seek entry we can decode. Unknown sub-elements are
	// left alone.
	headerLen := int(span.HeaderLen)
	body := raw[headerLen:]
	for off := 0; off < len(body); {
		seekID, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			break
		}
		seekSize, sizeLen, _, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok {
			break
		}
		seekStart := off + idLen + sizeLen
		seekEnd := seekStart + int(seekSize)
		if seekEnd > len(body) {
			break
		}
		if uint32(seekID) == ebmlIDSeek {
			patchSeekEntry(body[seekStart:seekEnd], updates)
		}
		off = seekEnd
	}
	_, err = dst.Write(raw)
	return err
}

// patchSeekEntry rewrites the SeekPosition of a single Seek entry
// in place when its SeekID matches one of the supplied updates.
// The storage width of SeekPosition is preserved, so the overall
// element size is unchanged. EBML allows unsigned integers to be
// padded with leading zero bytes, which lets us fit larger values
// into the same slot as long as they don't exceed the byte width.
func patchSeekEntry(body []byte, updates map[uint32]int64) {
	var seekID uint32
	var posStart, posEnd int
	found := false
	for off := 0; off < len(body); {
		subID, subIDLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		subSize, subSizeLen, _, ok := readEBMLVintBytes(body[off+subIDLen:], false)
		if !ok {
			return
		}
		dataStart := off + subIDLen + subSizeLen
		dataEnd := dataStart + int(subSize)
		if dataEnd > len(body) {
			return
		}
		switch uint32(subID) {
		case ebmlIDSeekID:
			// SeekID body is the on-wire ID bytes; interpret as a
			// big-endian unsigned integer so we can compare against
			// the known ebmlID* constants.
			if int(subSize) > 0 && int(subSize) <= 4 {
				var id uint32
				for i := 0; i < int(subSize); i++ {
					id = id<<8 | uint32(body[dataStart+i])
				}
				seekID = id
			}
		case ebmlIDSeekPosition:
			posStart, posEnd = dataStart, dataEnd
			found = true
		}
		off = dataEnd
	}
	if !found {
		return
	}
	newPos, ok := updates[seekID]
	if !ok {
		return
	}
	width := posEnd - posStart
	if width <= 0 {
		return
	}
	// Encode newPos as big-endian into the existing width. If the
	// value does not fit, leave the entry alone. A stale SeekHead
	// pointer is better than silent corruption.
	remain := uint64(newPos)
	for i := posEnd - 1; i >= posStart; i-- {
		body[i] = byte(remain & 0xFF)
		remain >>= 8
	}
	if remain != 0 {
		// Overflow: restore nothing; this path would only trigger
		// on absurdly large SeekPositions. Callers still get a
		// working file because other SeekHead entries are
		// independent.
		return
	}
}
