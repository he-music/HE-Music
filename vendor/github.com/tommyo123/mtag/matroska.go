package mtag

import (
	"encoding/binary"
	"io"
	"strconv"
	"strings"
	"time"
)

const (
	ebmlIDHeader           = 0x1A45DFA3
	ebmlIDSegment          = 0x18538067
	ebmlIDSeekHead         = 0x114D9B74
	ebmlIDSeek             = 0x4DBB
	ebmlIDSeekID           = 0x53AB
	ebmlIDSeekPosition     = 0x53AC
	ebmlIDInfo             = 0x1549A966
	ebmlIDTags             = 0x1254C367
	ebmlIDVoid             = 0xEC
	ebmlIDChapters         = 0x1043A770
	ebmlIDAttachments      = 0x1941A469
	ebmlIDTag              = 0x7373
	ebmlIDTargets          = 0x63C0
	ebmlIDTagChapterUID    = 0x63C4
	ebmlIDTagTrackUID      = 0x63C5
	ebmlIDTagAttachmentUID = 0x63C6
	ebmlIDTagEditionUID    = 0x63C9
	ebmlIDSimpleTag        = 0x67C8
	ebmlIDTagLanguage      = 0x447A
	ebmlIDTagDefault       = 0x4484
	ebmlIDTagName          = 0x45A3
	ebmlIDTagString        = 0x4487
	ebmlIDTargetTypeValue  = 0x68CA
	ebmlIDTargetType       = 0x63CA
	ebmlIDTitle            = 0x7BA9
	ebmlIDMuxingApp        = 0x4D80
	ebmlIDWritingApp       = 0x5741
	ebmlIDDateUTC          = 0x4461
	ebmlIDEditionEntry     = 0x45B9
	ebmlIDChapterAtom      = 0xB6
	ebmlIDChapterUID       = 0x73C4
	ebmlIDChapterTimeStart = 0x91
	ebmlIDChapterTimeEnd   = 0x92
	ebmlIDChapterDisplay   = 0x80
	ebmlIDChapString       = 0x85
	ebmlIDAttachedFile     = 0x61A7
	ebmlIDFileName         = 0x466E
	ebmlIDFileDescription  = 0x467E
	ebmlIDFileMimeType     = 0x4660
	ebmlIDFileData         = 0x465C
)

type matroskaField struct {
	Name  string
	Value string
}

type matroskaView struct {
	Fields        []matroskaField
	Attachments   []Attachment
	Pictures      []Picture
	Chapters      []Chapter
	RawTargetTags [][]byte
}

func (v *matroskaView) add(name, value string) {
	if v == nil || name == "" || value == "" {
		return
	}
	// Matroska can legitimately carry the same field in both the
	// Info element (TITLE, MUXING_APP, WRITING_APP, DATE) and inside
	// a Tags/SimpleTag block — older writers often duplicate them
	// for compatibility with older players. Dedupe on ingest so the
	// in-memory view has a single entry; otherwise every save cycle
	// would render the duplicate back into Tags and grow the file.
	if matroskaDedupeField(name) {
		for i := range v.Fields {
			if strings.EqualFold(v.Fields[i].Name, name) {
				v.Fields[i].Value = value
				return
			}
		}
	}
	v.Fields = append(v.Fields, matroskaField{Name: name, Value: value})
}

// matroskaDedupeField reports whether a field commonly appears in
// both the Info element and inside a Tags SimpleTag. We deduplicate
// those so the polymorphic view has one entry per logical field
// regardless of where the encoder put it.
func matroskaDedupeField(name string) bool {
	switch strings.ToUpper(name) {
	case "TITLE", "MUXING_APP", "WRITING_APP", "ENCODER",
		"CREATION_TIME", "DATE_RECORDED", "DATE":
		return true
	}
	return false
}

func (v *matroskaView) Get(name string) string {
	if v == nil {
		return ""
	}
	for i := len(v.Fields) - 1; i >= 0; i-- {
		if strings.EqualFold(v.Fields[i].Name, name) {
			return v.Fields[i].Value
		}
	}
	return ""
}

func (v *matroskaView) GetAll(name string) []string {
	if v == nil {
		return nil
	}
	var out []string
	for _, f := range v.Fields {
		if strings.EqualFold(f.Name, name) {
			out = append(out, f.Value)
		}
	}
	return out
}

func (v *matroskaView) Set(name, value string) {
	if v == nil || name == "" {
		return
	}
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		}
	}
	v.Fields = kept
	if value != "" {
		v.Fields = append(v.Fields, matroskaField{Name: name, Value: value})
	}
}

func (v *matroskaView) setAll(name string, values []string) {
	if v == nil || name == "" {
		return
	}
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		}
	}
	v.Fields = kept
	for _, value := range values {
		if value != "" {
			v.Fields = append(v.Fields, matroskaField{Name: name, Value: value})
		}
	}
}

func (f *File) detectMatroska() error {
	return f.detectMatroskaWith(openConfig{})
}

func (f *File) detectMatroskaWith(cfg openConfig) error {
	view, err := readMatroskaMetadata(f.src, f.size, cfg.skipAttachments)
	if err != nil {
		return nil
	}
	if view != nil {
		f.mkv = view
	}
	return nil
}

func readMatroskaMetadata(r io.ReaderAt, size int64, skipAttachments bool) (*matroskaView, error) {
	id, idLen, _, err := readEBMLVintAt(r, 0, true)
	if err != nil || id != ebmlIDHeader {
		return nil, err
	}
	headerSize, headerLen, unknown, err := readEBMLVintAt(r, int64(idLen), false)
	if err != nil {
		return nil, err
	}
	off := int64(idLen + headerLen)
	if !unknown {
		off += int64(headerSize)
	}
	view := &matroskaView{}
	for off < size {
		elemID, elemIDLen, _, err := readEBMLVintAt(r, off, true)
		if err != nil {
			break
		}
		elemSize, elemSizeLen, elemUnknown, err := readEBMLVintAt(r, off+int64(elemIDLen), false)
		if err != nil {
			break
		}
		dataAt := off + int64(elemIDLen+elemSizeLen)
		dataEnd := size
		if !elemUnknown {
			dataEnd = dataAt + int64(elemSize)
			if dataEnd > size {
				break
			}
		}
		if elemID == ebmlIDSegment {
			parseMatroskaSegment(r, dataAt, dataEnd, view, skipAttachments)
			break
		}
		if elemUnknown {
			break
		}
		off = dataEnd
	}
	if len(view.Fields) == 0 && len(view.Attachments) == 0 && len(view.Pictures) == 0 && len(view.Chapters) == 0 {
		return nil, nil
	}
	return view, nil
}

func parseMatroskaSegment(r io.ReaderAt, start, end int64, view *matroskaView, skipAttachments bool) {
	for off := start; off < end; {
		elemID, elemIDLen, _, err := readEBMLVintAt(r, off, true)
		if err != nil {
			return
		}
		elemSize, elemSizeLen, elemUnknown, err := readEBMLVintAt(r, off+int64(elemIDLen), false)
		if err != nil {
			return
		}
		dataAt := off + int64(elemIDLen+elemSizeLen)
		dataEnd := end
		if !elemUnknown {
			dataEnd = dataAt + int64(elemSize)
			if dataEnd > end {
				return
			}
		}
		switch elemID {
		case ebmlIDInfo:
			parseMatroskaInfo(r, dataAt, dataEnd, view)
		case ebmlIDTags:
			parseMatroskaTags(r, dataAt, dataEnd, view)
		case ebmlIDAttachments:
			if !skipAttachments {
				parseMatroskaAttachments(r, dataAt, dataEnd, view)
			}
		case ebmlIDChapters:
			parseMatroskaChapters(r, dataAt, dataEnd, view)
		}
		if elemUnknown {
			return
		}
		off = dataEnd
	}
}

func parseMatroskaInfo(r io.ReaderAt, start, end int64, view *matroskaView) {
	if end-start <= 0 || end-start > maxMatroskaElementBytes {
		return
	}
	body := make([]byte, end-start)
	if _, err := r.ReadAt(body, start); err != nil {
		return
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		data := body[dataAt:dataEnd]
		switch id {
		case ebmlIDTitle:
			view.add("TITLE", strings.TrimSpace(string(data)))
		case ebmlIDMuxingApp:
			view.add("MUXING_APP", strings.TrimSpace(string(data)))
		case ebmlIDWritingApp:
			s := strings.TrimSpace(string(data))
			view.add("WRITING_APP", s)
			view.add("ENCODER", s)
		case ebmlIDDateUTC:
			if ns, ok := parseEBMLInt(data); ok {
				t := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(ns))
				view.add("CREATION_TIME", t.Format(time.RFC3339Nano))
			}
		}
		off = dataEnd
	}
}

func parseMatroskaTags(r io.ReaderAt, start, end int64, view *matroskaView) {
	if end-start <= 0 || end-start > maxMatroskaElementBytes {
		return
	}
	body := make([]byte, end-start)
	if _, err := r.ReadAt(body, start); err != nil {
		return
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		if id == ebmlIDTag {
			parseMatroskaTagBody(body[dataAt:dataEnd], view)
		}
		off = dataEnd
	}
}

// MaxMatroskaAttachmentsBytes caps how many bytes of the Matroska
// "Attachments" element mtag will materialise on open. Typical files
// carry a handful of small attachments (cover art, metadata XML)
// well under a MiB; the 64 MiB ceiling leaves room for large cover
// images while blocking abusive inputs from forcing huge eager
// allocations.
const MaxMatroskaAttachmentsBytes = 64 << 20
const maxMatroskaElementBytes = 16 << 20

// parseMatroskaAttachments reads the full Attachments element into
// memory up to [MaxMatroskaAttachmentsBytes]. Anything larger is
// skipped silently — attachments then stay hidden from the
// polymorphic [File.Attachments] view rather than forcing the
// reader to allocate arbitrary amounts of heap.
func parseMatroskaAttachments(r io.ReaderAt, start, end int64, view *matroskaView) {
	size := end - start
	if size <= 0 || size > MaxMatroskaAttachmentsBytes {
		return
	}
	body := make([]byte, size)
	if _, err := r.ReadAt(body, start); err != nil {
		return
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		if id == ebmlIDAttachedFile {
			parseMatroskaAttachedFile(body[dataAt:dataEnd], view)
		}
		off = dataEnd
	}
}

func parseMatroskaAttachedFile(body []byte, view *matroskaView) {
	var att Attachment
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			break
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			break
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			break
		}
		data := body[dataAt:dataEnd]
		switch id {
		case ebmlIDFileName:
			att.Name = strings.TrimSpace(string(data))
		case ebmlIDFileDescription:
			att.Description = strings.TrimSpace(string(data))
		case ebmlIDFileMimeType:
			att.MIME = strings.TrimSpace(string(data))
		case ebmlIDFileData:
			att.Data = append([]byte(nil), data...)
		}
		off = dataEnd
	}
	if len(att.Data) == 0 {
		return
	}
	if att.MIME == "" || !strings.Contains(att.MIME, "/") {
		if guessed := guessImageMIME(att.Name, att.Data); guessed != "application/octet-stream" {
			att.MIME = guessed
		}
	}
	view.Attachments = append(view.Attachments, att)
	if mime := canonicalAttachmentMIME(att.MIME, att.Name, att.Data); mime != "" {
		view.Pictures = append(view.Pictures, Picture{
			MIME:        mime,
			Type:        pictureTypeFromAttachment(att),
			Description: att.Description,
			Data:        att.Data,
		})
	}
}

func parseMatroskaChapters(r io.ReaderAt, start, end int64, view *matroskaView) {
	if end-start <= 0 || end-start > maxMatroskaElementBytes {
		return
	}
	body := make([]byte, end-start)
	if _, err := r.ReadAt(body, start); err != nil {
		return
	}
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		if id == ebmlIDEditionEntry {
			parseMatroskaEdition(body[dataAt:dataEnd], view)
		}
		off = dataEnd
	}
}

func parseMatroskaEdition(body []byte, view *matroskaView) {
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		if id == ebmlIDChapterAtom {
			parseMatroskaChapterAtom(body[dataAt:dataEnd], view)
		}
		off = dataEnd
	}
}

func parseMatroskaChapterAtom(body []byte, view *matroskaView) {
	var ch Chapter
	var have bool
	var nested [][]byte
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			break
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			break
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			break
		}
		data := body[dataAt:dataEnd]
		switch id {
		case ebmlIDChapterUID:
			if u, ok := parseEBMLUInt(data); ok {
				ch.ID = strings.TrimSpace(strconv.FormatUint(u, 10))
			}
		case ebmlIDChapterTimeStart:
			if u, ok := parseEBMLUInt(data); ok {
				ch.Start = time.Duration(u)
				have = true
			}
		case ebmlIDChapterTimeEnd:
			if u, ok := parseEBMLUInt(data); ok {
				ch.End = time.Duration(u)
				have = true
			}
		case ebmlIDChapterDisplay:
			parseMatroskaChapterDisplay(data, &ch)
		case ebmlIDChapterAtom:
			nested = append(nested, append([]byte(nil), data...))
		}
		off = dataEnd
	}
	if have || ch.Title != "" || ch.ID != "" {
		view.Chapters = append(view.Chapters, ch)
	}
	for _, child := range nested {
		parseMatroskaChapterAtom(child, view)
	}
}

func parseMatroskaChapterDisplay(body []byte, ch *Chapter) {
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		if id == ebmlIDChapString && ch.Title == "" {
			ch.Title = strings.TrimSpace(string(body[dataAt:dataEnd]))
		}
		off = dataEnd
	}
}

func parseMatroskaTagBody(body []byte, view *matroskaView) {
	fileLevel := true
	var simpleTags [][]byte
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return
		}
		switch id {
		case ebmlIDTargets:
			if !matroskaTagTargetsAreFileLevel(body[dataAt:dataEnd]) {
				fileLevel = false
			}
		case ebmlIDSimpleTag:
			simpleTags = append(simpleTags, append([]byte(nil), body[dataAt:dataEnd]...))
		}
		off = dataEnd
	}
	if !fileLevel {
		view.RawTargetTags = append(view.RawTargetTags, renderEBMLElement(ebmlIDBytesTag, append([]byte(nil), body...)))
		return
	}
	for _, simple := range simpleTags {
		parseMatroskaSimpleTag(simple, view)
	}
}

func matroskaTagTargetsAreFileLevel(body []byte) bool {
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			return true
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			return true
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			return true
		}
		switch id {
		case ebmlIDTagTrackUID, ebmlIDTagChapterUID, ebmlIDTagAttachmentUID, ebmlIDTagEditionUID:
			if v, ok := parseEBMLUInt(body[dataAt:dataEnd]); ok && v != 0 {
				return false
			}
		}
		off = dataEnd
	}
	return true
}

func parseMatroskaSimpleTag(body []byte, view *matroskaView) {
	name := ""
	value := ""
	for off := 0; off < len(body); {
		id, idLen, _, ok := readEBMLVintBytes(body[off:], true)
		if !ok {
			break
		}
		sizeVal, sizeLen, unknown, ok := readEBMLVintBytes(body[off+idLen:], false)
		if !ok || unknown {
			break
		}
		dataAt := off + idLen + sizeLen
		dataEnd := dataAt + int(sizeVal)
		if dataEnd > len(body) {
			break
		}
		switch id {
		case ebmlIDTagName:
			name = strings.TrimSpace(string(body[dataAt:dataEnd]))
		case ebmlIDTagString:
			value = strings.TrimSpace(string(body[dataAt:dataEnd]))
		case ebmlIDSimpleTag:
			parseMatroskaSimpleTag(body[dataAt:dataEnd], view)
		}
		off = dataEnd
	}
	if name != "" && value != "" {
		view.add(name, value)
	}
}

func readEBMLVintAt(r io.ReaderAt, off int64, keepMarker bool) (uint64, int, bool, error) {
	var first [1]byte
	if _, err := r.ReadAt(first[:], off); err != nil {
		return 0, 0, false, err
	}
	width := ebmlVintWidth(first[0])
	if width == 0 {
		return 0, 0, false, io.ErrUnexpectedEOF
	}
	var buf [8]byte
	buf[0] = first[0]
	if width > 1 {
		if _, err := r.ReadAt(buf[1:width], off+1); err != nil {
			return 0, 0, false, err
		}
	}
	v, unknown := decodeEBMLVint(buf[:width], keepMarker)
	return v, width, unknown, nil
}

func readEBMLVintBytes(b []byte, keepMarker bool) (uint64, int, bool, bool) {
	if len(b) == 0 {
		return 0, 0, false, false
	}
	width := ebmlVintWidth(b[0])
	if width == 0 || width > len(b) {
		return 0, 0, false, false
	}
	v, unknown := decodeEBMLVint(b[:width], keepMarker)
	return v, width, unknown, true
}

func ebmlVintWidth(first byte) int {
	mask := byte(0x80)
	for width := 1; width <= 8; width++ {
		if first&mask != 0 {
			return width
		}
		mask >>= 1
	}
	return 0
}

func decodeEBMLVint(b []byte, keepMarker bool) (uint64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	mask := byte(0x80 >> (len(b) - 1))
	var v uint64
	if keepMarker {
		v = uint64(b[0])
	} else {
		v = uint64(b[0] & ^mask)
	}
	for _, x := range b[1:] {
		v = (v << 8) | uint64(x)
	}
	if keepMarker {
		return v, false
	}
	lowMask := byte(mask - 1)
	unknown := true
	if b[0]&lowMask != lowMask {
		unknown = false
	}
	for _, x := range b[1:] {
		if x != 0xFF {
			unknown = false
		}
	}
	return v, unknown
}

func parseEBMLInt(b []byte) (int64, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	var buf [8]byte
	copy(buf[8-len(b):], b)
	if b[0]&0x80 != 0 {
		for i := 0; i < 8-len(b); i++ {
			buf[i] = 0xFF
		}
	}
	return int64(binary.BigEndian.Uint64(buf[:])), true
}

func parseEBMLUInt(b []byte) (uint64, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	var buf [8]byte
	copy(buf[8-len(b):], b)
	return binary.BigEndian.Uint64(buf[:]), true
}

func canonicalAttachmentMIME(mime, name string, data []byte) string {
	mime = strings.TrimSpace(mime)
	if strings.HasPrefix(strings.ToLower(mime), "image/") {
		return mime
	}
	if guessed := guessImageMIME(name, data); guessed != "application/octet-stream" {
		return guessed
	}
	return ""
}

func pictureTypeFromAttachment(att Attachment) PictureType {
	text := strings.ToLower(att.Name + " " + att.Description)
	if strings.Contains(text, "back") || strings.Contains(text, "rear") {
		return PictureCoverBack
	}
	if strings.Contains(text, "cover") || strings.Contains(text, "poster") || strings.Contains(text, "folder") {
		return PictureCoverFront
	}
	return PictureOther
}

type matroskaTagView struct{ v *matroskaView }

func (v *matroskaTagView) Kind() TagKind { return TagMatroska }

func (v *matroskaTagView) Keys() []string {
	if v.v == nil {
		return nil
	}
	out := make([]string, 0, len(v.v.Fields))
	seen := make(map[string]bool, len(v.v.Fields))
	for _, f := range v.v.Fields {
		if shouldSkipMatroskaTagField(f.Name) {
			continue
		}
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}

func (v *matroskaTagView) Get(name string) string { return v.v.Get(name) }
