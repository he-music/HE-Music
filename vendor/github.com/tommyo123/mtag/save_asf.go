package mtag

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

type asfHeaderSlotKind uint8

const (
	asfHeaderSlotRaw asfHeaderSlotKind = iota
	asfHeaderSlotContentDescription
	asfHeaderSlotExtendedContent
	asfHeaderSlotHeaderExtension
	asfHeaderSlotMetadata
	asfHeaderSlotMetadataLibrary
)

type asfHeaderSlot struct {
	Kind asfHeaderSlotKind
	Raw  []byte
}

type asfHeaderLayout struct {
	Prefix      []byte
	HeaderSize  int64
	Children    []asfHeaderSlot
	ExtReserved []byte
	ExtChildren []asfHeaderSlot
}

func scanASFHeaderLayout(r WritableSource, size int64) (*asfHeaderLayout, error) {
	if size < 30 {
		return nil, fmt.Errorf("asf: short file")
	}
	var head [30]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	var guid [16]byte
	copy(guid[:], head[:16])
	if guid != asfHeaderObjectGUID {
		return nil, fmt.Errorf("asf: bad header GUID")
	}
	headerSize := int64(binary.LittleEndian.Uint64(head[16:24]))
	if headerSize < 30 || headerSize > size {
		return nil, fmt.Errorf("asf: invalid header size %d", headerSize)
	}
	count := binary.LittleEndian.Uint32(head[24:28])
	layout := &asfHeaderLayout{
		Prefix:      append([]byte(nil), head[:]...),
		HeaderSize:  headerSize,
		ExtReserved: append([]byte(nil), asfHeaderExtReserved[:]...),
	}
	cursor := int64(30)
	for i := uint32(0); i < count && cursor+24 <= headerSize; i++ {
		var objHead [24]byte
		if _, err := r.ReadAt(objHead[:], cursor); err != nil {
			return nil, err
		}
		objSize := int64(binary.LittleEndian.Uint64(objHead[16:24]))
		if objSize < 24 || cursor+objSize > headerSize {
			return nil, fmt.Errorf("asf: invalid child object size")
		}
		raw := make([]byte, objSize)
		if _, err := r.ReadAt(raw, cursor); err != nil {
			return nil, err
		}
		copy(guid[:], raw[:16])
		switch guid {
		case asfContentDescGUID:
			layout.Children = append(layout.Children, asfHeaderSlot{Kind: asfHeaderSlotContentDescription})
		case asfExtContentGUID:
			layout.Children = append(layout.Children, asfHeaderSlot{Kind: asfHeaderSlotExtendedContent})
		case asfHeaderExtGUID:
			layout.Children = append(layout.Children, asfHeaderSlot{Kind: asfHeaderSlotHeaderExtension})
			parseASFHeaderExtensionLayout(raw[24:], layout)
		default:
			layout.Children = append(layout.Children, asfHeaderSlot{Kind: asfHeaderSlotRaw, Raw: raw})
		}
		cursor += objSize
	}
	return layout, nil
}

func parseASFHeaderExtensionLayout(body []byte, layout *asfHeaderLayout) {
	if len(body) < 22 {
		return
	}
	layout.ExtReserved = append(layout.ExtReserved[:0], body[:18]...)
	dataLen := int(binary.LittleEndian.Uint32(body[18:22]))
	if dataLen < 0 {
		return
	}
	if 22+dataLen > len(body) {
		dataLen = len(body) - 22
	}
	data := body[22 : 22+dataLen]
	cur := 0
	for cur+24 <= len(data) {
		raw := data[cur:]
		objSize := int(binary.LittleEndian.Uint64(raw[16:24]))
		if objSize < 24 || cur+objSize > len(data) {
			return
		}
		chunk := append([]byte(nil), raw[:objSize]...)
		var guid [16]byte
		copy(guid[:], chunk[:16])
		switch guid {
		case asfMetadataGUID:
			layout.ExtChildren = append(layout.ExtChildren, asfHeaderSlot{Kind: asfHeaderSlotMetadata})
		case asfMetadataLibGUID:
			layout.ExtChildren = append(layout.ExtChildren, asfHeaderSlot{Kind: asfHeaderSlotMetadataLibrary})
		default:
			layout.ExtChildren = append(layout.ExtChildren, asfHeaderSlot{Kind: asfHeaderSlotRaw, Raw: chunk})
		}
		cur += objSize
	}
}

func renderASFObject(guid [16]byte, body []byte) []byte {
	out := make([]byte, 24+len(body))
	copy(out[:16], guid[:])
	binary.LittleEndian.PutUint64(out[16:24], uint64(len(out)))
	copy(out[24:], body)
	return out
}

func renderASFString(s string) []byte {
	u16 := utf16.Encode([]rune(s))
	out := make([]byte, 0, len(u16)*2+2)
	for _, x := range u16 {
		var tmp [2]byte
		binary.LittleEndian.PutUint16(tmp[:], x)
		out = append(out, tmp[:]...)
	}
	out = append(out, 0, 0)
	return out
}

func renderASFContentDescription(view *asfView) []byte {
	fields := []string{
		view.Get("Title"),
		view.Get("Author"),
		view.Get("Copyright"),
		view.Get("Description"),
		view.Get("Rating"),
	}
	parts := make([][]byte, len(fields))
	bodyLen := 10
	for i, s := range fields {
		parts[i] = renderASFString(s)
		bodyLen += len(parts[i])
	}
	body := make([]byte, 0, bodyLen)
	for _, p := range parts {
		var lenBuf [2]byte
		binary.LittleEndian.PutUint16(lenBuf[:], uint16(len(p)))
		body = append(body, lenBuf[:]...)
	}
	for _, p := range parts {
		body = append(body, p...)
	}
	return renderASFObject(asfContentDescGUID, body)
}

func isASFContentDescriptionName(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "title", "author", "copyright", "description", "rating":
		return true
	}
	return false
}

func encodeASFGUIDString(s string) ([]byte, bool) {
	clean := strings.TrimSpace(strings.Trim(s, "{}"))
	clean = strings.ReplaceAll(clean, "-", "")
	if len(clean) != 32 {
		return nil, false
	}
	raw, err := hex.DecodeString(clean)
	if err != nil || len(raw) != 16 {
		return nil, false
	}
	return raw, true
}

func renderASFAttributeValue(field asfField, kind asfHeaderSlotKind) ([]byte, uint16, error) {
	typ := field.Type
	switch typ {
	case asfTypeWord:
		var out [2]byte
		v, _ := strconv.ParseUint(strings.TrimSpace(field.Value), 10, 16)
		binary.LittleEndian.PutUint16(out[:], uint16(v))
		return out[:], typ, nil
	case asfTypeBool:
		isTrue := strings.TrimSpace(field.Value) != "" && strings.TrimSpace(field.Value) != "0" && !strings.EqualFold(strings.TrimSpace(field.Value), "false")
		if kind == asfHeaderSlotExtendedContent {
			var out [4]byte
			if isTrue {
				binary.LittleEndian.PutUint32(out[:], 1)
			}
			return out[:], typ, nil
		}
		var out [2]byte
		if isTrue {
			binary.LittleEndian.PutUint16(out[:], 1)
		}
		return out[:], typ, nil
	case asfTypeDWord:
		var out [4]byte
		v, _ := strconv.ParseUint(strings.TrimSpace(field.Value), 10, 32)
		binary.LittleEndian.PutUint32(out[:], uint32(v))
		return out[:], typ, nil
	case asfTypeQWord:
		var out [8]byte
		v, _ := strconv.ParseUint(strings.TrimSpace(field.Value), 10, 64)
		binary.LittleEndian.PutUint64(out[:], v)
		return out[:], typ, nil
	case asfTypeGUID:
		if raw, ok := encodeASFGUIDString(field.Value); ok {
			return raw, typ, nil
		}
		typ = asfTypeUnicode
	case asfTypeBytes:
		return []byte(field.Value), typ, nil
	}
	return renderASFString(field.Value), asfTypeUnicode, nil
}

func renderASFAttribute(field asfField, kind asfHeaderSlotKind) ([]byte, error) {
	nameData := renderASFString(field.Name)
	valueData, typ, err := renderASFAttributeValue(field, kind)
	if err != nil {
		return nil, err
	}
	var body bytes.Buffer
	switch kind {
	case asfHeaderSlotExtendedContent:
		var tmp [2]byte
		binary.LittleEndian.PutUint16(tmp[:], uint16(len(nameData)))
		body.Write(tmp[:])
		body.Write(nameData)
		binary.LittleEndian.PutUint16(tmp[:], typ)
		body.Write(tmp[:])
		binary.LittleEndian.PutUint16(tmp[:], uint16(len(valueData)))
		body.Write(tmp[:])
		body.Write(valueData)
	case asfHeaderSlotMetadata, asfHeaderSlotMetadataLibrary:
		var word [2]byte
		var dword [4]byte
		lang := uint16(0)
		if kind == asfHeaderSlotMetadataLibrary {
			lang = field.Language
		}
		binary.LittleEndian.PutUint16(word[:], lang)
		body.Write(word[:])
		binary.LittleEndian.PutUint16(word[:], field.Stream)
		body.Write(word[:])
		binary.LittleEndian.PutUint16(word[:], uint16(len(nameData)))
		body.Write(word[:])
		binary.LittleEndian.PutUint16(word[:], typ)
		body.Write(word[:])
		binary.LittleEndian.PutUint32(dword[:], uint32(len(valueData)))
		body.Write(dword[:])
		body.Write(nameData)
		body.Write(valueData)
	default:
		return nil, fmt.Errorf("asf: bad attribute kind")
	}
	return body.Bytes(), nil
}

func renderASFPictureAttribute(pic Picture) ([]byte, error) {
	var value bytes.Buffer
	value.WriteByte(byte(pic.Type))
	var sizeBuf [4]byte
	binary.LittleEndian.PutUint32(sizeBuf[:], uint32(len(pic.Data)))
	value.Write(sizeBuf[:])
	value.Write(renderASFString(pic.MIME))
	value.Write(renderASFString(pic.Description))
	value.Write(pic.Data)
	field := asfField{Name: "WM/Picture", Type: asfTypeBytes}
	field.Value = string(value.Bytes())
	return renderASFAttribute(field, asfHeaderSlotMetadataLibrary)
}

func partitionASFAttributes(view *asfView) (ext, meta, lib [][]byte, err error) {
	if view == nil {
		return nil, nil, nil, nil
	}
	for _, field := range view.Fields {
		if isASFContentDescriptionName(field.Name) {
			continue
		}
		target := asfHeaderSlotExtendedContent
		valueData, _, e := renderASFAttributeValue(field, asfHeaderSlotExtendedContent)
		if e != nil {
			return nil, nil, nil, e
		}
		switch {
		case field.Language != 0:
			target = asfHeaderSlotMetadataLibrary
		case field.Stream != 0:
			target = asfHeaderSlotMetadata
		case field.Type == asfTypeGUID:
			target = asfHeaderSlotMetadataLibrary
		case len(valueData) > 0xFFFF:
			target = asfHeaderSlotMetadataLibrary
		}
		raw, e := renderASFAttribute(field, target)
		if e != nil {
			return nil, nil, nil, e
		}
		switch target {
		case asfHeaderSlotExtendedContent:
			ext = append(ext, raw)
		case asfHeaderSlotMetadata:
			meta = append(meta, raw)
		case asfHeaderSlotMetadataLibrary:
			lib = append(lib, raw)
		}
	}
	for _, pic := range view.Pictures {
		raw, e := renderASFPictureAttribute(pic)
		if e != nil {
			return nil, nil, nil, e
		}
		lib = append(lib, raw)
	}
	return ext, meta, lib, nil
}

func renderASFAttributeObject(guid [16]byte, attrs [][]byte) []byte {
	var body bytes.Buffer
	var count [2]byte
	binary.LittleEndian.PutUint16(count[:], uint16(len(attrs)))
	body.Write(count[:])
	for _, raw := range attrs {
		body.Write(raw)
	}
	return renderASFObject(guid, body.Bytes())
}

func renderASFHeaderExtension(layout *asfHeaderLayout, metaObj, libObj []byte) []byte {
	var data bytes.Buffer
	usedMeta := false
	usedLib := false
	for _, slot := range layout.ExtChildren {
		switch slot.Kind {
		case asfHeaderSlotRaw:
			data.Write(slot.Raw)
		case asfHeaderSlotMetadata:
			if len(metaObj) > 0 && !usedMeta {
				data.Write(metaObj)
				usedMeta = true
			}
		case asfHeaderSlotMetadataLibrary:
			if len(libObj) > 0 && !usedLib {
				data.Write(libObj)
				usedLib = true
			}
		}
	}
	if len(metaObj) > 0 && !usedMeta {
		data.Write(metaObj)
	}
	if len(libObj) > 0 && !usedLib {
		data.Write(libObj)
	}
	if data.Len() == 0 && len(layout.ExtChildren) == 0 {
		return nil
	}
	var body bytes.Buffer
	if len(layout.ExtReserved) == 18 {
		body.Write(layout.ExtReserved)
	} else {
		body.Write(asfHeaderExtReserved[:])
	}
	var sizeBuf [4]byte
	binary.LittleEndian.PutUint32(sizeBuf[:], uint32(data.Len()))
	body.Write(sizeBuf[:])
	body.Write(data.Bytes())
	return renderASFObject(asfHeaderExtGUID, body.Bytes())
}

func (f *File) saveASF() error {
	w, err := f.writable()
	if err != nil {
		return err
	}
	layout, err := scanASFHeaderLayout(w, f.size)
	if err != nil {
		return err
	}
	if f.asf == nil {
		f.asf = &asfView{}
	}
	extAttrs, metaAttrs, libAttrs, err := partitionASFAttributes(f.asf)
	if err != nil {
		return err
	}
	contentObj := renderASFContentDescription(f.asf)
	extObj := []byte(nil)
	if len(extAttrs) > 0 {
		extObj = renderASFAttributeObject(asfExtContentGUID, extAttrs)
	}
	metaObj := []byte(nil)
	if len(metaAttrs) > 0 {
		metaObj = renderASFAttributeObject(asfMetadataGUID, metaAttrs)
	}
	libObj := []byte(nil)
	if len(libAttrs) > 0 {
		libObj = renderASFAttributeObject(asfMetadataLibGUID, libAttrs)
	}
	headerExtObj := renderASFHeaderExtension(layout, metaObj, libObj)

	var children [][]byte
	usedContent := false
	usedExt := false
	usedHeaderExt := false
	for _, slot := range layout.Children {
		switch slot.Kind {
		case asfHeaderSlotRaw:
			children = append(children, slot.Raw)
		case asfHeaderSlotContentDescription:
			children = append(children, contentObj)
			usedContent = true
		case asfHeaderSlotExtendedContent:
			if len(extObj) > 0 {
				children = append(children, extObj)
			}
			usedExt = true
		case asfHeaderSlotHeaderExtension:
			if len(headerExtObj) > 0 {
				children = append(children, headerExtObj)
			}
			usedHeaderExt = true
		}
	}
	if len(contentObj) > 0 && !usedContent {
		children = append(children, contentObj)
	}
	if len(extObj) > 0 && !usedExt {
		children = append(children, extObj)
	}
	if len(headerExtObj) > 0 && !usedHeaderExt {
		children = append(children, headerExtObj)
	}

	var header bytes.Buffer
	header.Write(layout.Prefix)
	for _, child := range children {
		header.Write(child)
	}
	outHeader := header.Bytes()
	binary.LittleEndian.PutUint64(outHeader[16:24], uint64(len(outHeader)))
	binary.LittleEndian.PutUint32(outHeader[24:28], uint32(len(children)))

	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if _, err := tmp.Write(outHeader); err != nil {
				return err
			}
			if err := copyRangeCtx(f.saveCtx, tmp, f.src, layout.HeaderSize, f.size-layout.HeaderSize); err != nil {
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
	if _, err := tmp.Write(outHeader); err != nil {
		cleanup()
		return err
	}
	if err := copyRangeCtx(f.saveCtx, tmp, f.src, layout.HeaderSize, f.size-layout.HeaderSize); err != nil {
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
