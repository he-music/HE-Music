package mtag

import (
	"encoding/binary"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/tommyo123/mtag/id3v2"
)

var (
	asfHeaderObjectGUID  = [16]byte{0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C}
	asfHeaderExtGUID     = [16]byte{0xB5, 0x03, 0xBF, 0x5F, 0x2E, 0xA9, 0xCF, 0x11, 0x8E, 0xE3, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65}
	asfContentDescGUID   = [16]byte{0x33, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C}
	asfExtContentGUID    = [16]byte{0x40, 0xA4, 0xD0, 0xD2, 0x07, 0xE3, 0xD2, 0x11, 0x97, 0xF0, 0x00, 0xA0, 0xC9, 0x5E, 0xA8, 0x50}
	asfMetadataGUID      = [16]byte{0xEA, 0xCB, 0xF8, 0xC5, 0xAF, 0x5B, 0x77, 0x48, 0x84, 0x67, 0xAA, 0x8C, 0x44, 0xFA, 0x4C, 0xCA}
	asfMetadataLibGUID   = [16]byte{0x94, 0x1C, 0x23, 0x44, 0x98, 0x94, 0xD1, 0x49, 0xA1, 0x41, 0x1D, 0x13, 0x4E, 0x45, 0x70, 0x54}
	asfHeaderExtReserved = [18]byte{0x11, 0xD2, 0xD3, 0xAB, 0xBA, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65, 0x06, 0x00}
)

type asfField struct {
	Name     string
	Value    string
	Type     uint16
	Stream   uint16
	Language uint16
}

type asfView struct {
	Fields   []asfField
	Pictures []Picture
}

const (
	asfTypeUnicode uint16 = iota
	asfTypeBytes
	asfTypeBool
	asfTypeDWord
	asfTypeQWord
	asfTypeWord
	asfTypeGUID
)

func (v *asfView) Get(name string) string {
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

func (v *asfView) GetAll(name string) []string {
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

func (v *asfView) Set(name, value string) {
	if v == nil {
		return
	}
	typ, stream, lang := asfTypeForName(name), uint16(0), uint16(0)
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		} else {
			typ, stream, lang = f.Type, f.Stream, f.Language
		}
	}
	v.Fields = kept
	if value != "" {
		v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: typ, Stream: stream, Language: lang})
	}
}

func (v *asfView) SetTyped(name, value string, typ uint16) {
	if v == nil {
		return
	}
	stream, lang := uint16(0), uint16(0)
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		} else {
			stream, lang = f.Stream, f.Language
		}
	}
	v.Fields = kept
	if value != "" {
		v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: typ, Stream: stream, Language: lang})
	}
}

func (v *asfView) setAll(name string, values []string) {
	if v == nil {
		return
	}
	typ, stream, lang := asfTypeForName(name), uint16(0), uint16(0)
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		} else {
			typ, stream, lang = f.Type, f.Stream, f.Language
		}
	}
	v.Fields = kept
	for _, value := range values {
		v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: typ, Stream: stream, Language: lang})
	}
}

const maxASFObjectBytes = 16 << 20

func (f *File) detectASF() error {
	return f.detectASFWith(openConfig{})
}

func (f *File) detectASFWith(cfg openConfig) error {
	view, err := readASFMetadataWithOptions(f.src, f.size, cfg.skipPictures)
	if err != nil {
		return err
	}
	f.asf = view
	return nil
}

func readASFMetadata(r io.ReaderAt, size int64) (*asfView, error) {
	return readASFMetadataWithOptions(r, size, false)
}

func readASFMetadataWithOptions(r io.ReaderAt, size int64, skipPictures bool) (*asfView, error) {
	if size < 30 {
		return nil, fmt.Errorf("asf: short file")
	}
	var head [30]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	var headerGUID [16]byte
	copy(headerGUID[:], head[:16])
	if headerGUID != asfHeaderObjectGUID {
		return nil, fmt.Errorf("asf: bad header GUID")
	}
	headerSize := int64(binary.LittleEndian.Uint64(head[16:24]))
	if headerSize < 30 {
		headerSize = 30
	}
	if headerSize > size {
		headerSize = size
	}
	count := binary.LittleEndian.Uint32(head[24:28])
	view := &asfView{}
	cursor := int64(30)
	for i := uint32(0); i < count && cursor+24 <= headerSize; i++ {
		var objHead [24]byte
		if _, err := r.ReadAt(objHead[:], cursor); err != nil {
			break
		}
		var guid [16]byte
		copy(guid[:], objHead[:16])
		objSize := int64(binary.LittleEndian.Uint64(objHead[16:24]))
		if objSize < 24 || cursor+objSize > headerSize {
			break
		}
		if objSize-24 > maxASFObjectBytes {
			cursor += objSize
			continue
		}
		body := make([]byte, objSize-24)
		if len(body) > 0 {
			if _, err := r.ReadAt(body, cursor+24); err != nil {
				break
			}
		}
		switch guid {
		case asfContentDescGUID:
			parseASFContentDescription(view, body)
		case asfExtContentGUID:
			parseASFExtendedContentDescription(view, body, skipPictures)
		case asfHeaderExtGUID:
			parseASFHeaderExtension(view, body, skipPictures)
		}
		cursor += objSize
	}
	return view, nil
}

func parseASFContentDescription(v *asfView, body []byte) {
	if len(body) < 10 {
		return
	}
	cur := 0
	lens := [5]int{}
	for i := 0; i < 5; i++ {
		lens[i] = int(binary.LittleEndian.Uint16(body[cur:]))
		cur += 2
	}
	names := [5]string{"Title", "Author", "Copyright", "Description", "Rating"}
	for i, n := range names {
		if cur+lens[i] > len(body) {
			return
		}
		s := decodeUTF16LE(body[cur : cur+lens[i]])
		cur += lens[i]
		if s != "" {
			v.Fields = append(v.Fields, asfField{Name: n, Value: s, Type: asfTypeUnicode})
		}
	}
}

func parseASFExtendedContentDescription(v *asfView, body []byte, skipPictures bool) {
	if len(body) < 2 {
		return
	}
	cur := 0
	count := int(binary.LittleEndian.Uint16(body[cur:]))
	cur += 2
	for i := 0; i < count; i++ {
		if cur+8 > len(body) {
			return
		}
		nameLen := int(binary.LittleEndian.Uint16(body[cur:]))
		cur += 2
		if cur+nameLen > len(body) {
			return
		}
		name := decodeUTF16LE(body[cur : cur+nameLen])
		cur += nameLen
		if cur+4 > len(body) {
			return
		}
		valueType := binary.LittleEndian.Uint16(body[cur:])
		cur += 2
		valueLen := int(binary.LittleEndian.Uint16(body[cur:]))
		cur += 2
		if cur+valueLen > len(body) {
			return
		}
		if !skipPictures && strings.EqualFold(name, "WM/Picture") && valueType == 1 {
			if pic, ok := decodeASFPicture(body[cur : cur+valueLen]); ok {
				v.Pictures = append(v.Pictures, pic)
			}
			cur += valueLen
			continue
		}
		value := decodeASFValue(valueType, body[cur:cur+valueLen])
		cur += valueLen
		if name != "" && value != "" {
			v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: valueType})
		}
	}
}

func parseASFHeaderExtension(v *asfView, body []byte, skipPictures bool) {
	if len(body) < 22 {
		return
	}
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
		var guid [16]byte
		copy(guid[:], data[cur:cur+16])
		objSize := int(binary.LittleEndian.Uint64(data[cur+16 : cur+24]))
		if objSize < 24 || cur+objSize > len(data) {
			return
		}
		objBody := data[cur+24 : cur+objSize]
		switch guid {
		case asfMetadataGUID:
			parseASFMetadataObject(v, objBody, skipPictures)
		case asfMetadataLibGUID:
			parseASFMetadataLibraryObject(v, objBody, skipPictures)
		}
		cur += objSize
	}
}

func parseASFMetadataObject(v *asfView, body []byte, skipPictures bool) {
	if len(body) < 2 {
		return
	}
	cur := 0
	count := int(binary.LittleEndian.Uint16(body[cur:]))
	cur += 2
	for i := 0; i < count; i++ {
		if cur+12 > len(body) {
			return
		}
		nameLen := int(binary.LittleEndian.Uint16(body[cur+4:]))
		valueType := binary.LittleEndian.Uint16(body[cur+6:])
		valueLen := int(binary.LittleEndian.Uint32(body[cur+8:]))
		stream := binary.LittleEndian.Uint16(body[cur+2:])
		cur += 12
		if nameLen < 0 || valueLen < 0 || cur+nameLen+valueLen > len(body) {
			return
		}
		name := decodeUTF16LE(body[cur : cur+nameLen])
		cur += nameLen
		if !skipPictures && strings.EqualFold(name, "WM/Picture") && valueType == 1 {
			if pic, ok := decodeASFPicture(body[cur : cur+valueLen]); ok {
				v.Pictures = append(v.Pictures, pic)
			}
			cur += valueLen
			continue
		}
		value := decodeASFValue(valueType, body[cur:cur+valueLen])
		cur += valueLen
		if name != "" && value != "" {
			v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: valueType, Stream: stream})
		}
	}
}

func parseASFMetadataLibraryObject(v *asfView, body []byte, skipPictures bool) {
	if len(body) < 2 {
		return
	}
	cur := 0
	count := int(binary.LittleEndian.Uint16(body[cur:]))
	cur += 2
	for i := 0; i < count; i++ {
		if cur+12 > len(body) {
			return
		}
		lang := binary.LittleEndian.Uint16(body[cur:])
		stream := binary.LittleEndian.Uint16(body[cur+2:])
		nameLen := int(binary.LittleEndian.Uint16(body[cur+4:]))
		valueType := binary.LittleEndian.Uint16(body[cur+6:])
		valueLen := int(binary.LittleEndian.Uint32(body[cur+8:]))
		cur += 12
		if nameLen < 0 || valueLen < 0 || cur+nameLen+valueLen > len(body) {
			return
		}
		name := decodeUTF16LE(body[cur : cur+nameLen])
		cur += nameLen
		if !skipPictures && strings.EqualFold(name, "WM/Picture") && valueType == 1 {
			if pic, ok := decodeASFPicture(body[cur : cur+valueLen]); ok {
				v.Pictures = append(v.Pictures, pic)
			}
			cur += valueLen
			continue
		}
		value := decodeASFValue(valueType, body[cur:cur+valueLen])
		cur += valueLen
		if name != "" && value != "" {
			v.Fields = append(v.Fields, asfField{Name: name, Value: value, Type: valueType, Stream: stream, Language: lang})
		}
	}
}

func decodeASFPicture(raw []byte) (Picture, bool) {
	if len(raw) < 5 {
		return Picture{}, false
	}
	pt := PictureType(raw[0])
	dataLen := int(binary.LittleEndian.Uint32(raw[1:5]))
	cur := 5
	mime, n, ok := decodeASFWideNULTerminated(raw[cur:])
	if !ok {
		return Picture{}, false
	}
	cur += n
	desc, n, ok := decodeASFWideNULTerminated(raw[cur:])
	if !ok {
		return Picture{}, false
	}
	cur += n
	if cur > len(raw) {
		return Picture{}, false
	}
	if dataLen < 0 || dataLen > len(raw)-cur {
		dataLen = len(raw) - cur
	}
	data := append([]byte(nil), raw[cur:cur+dataLen]...)
	mime = strings.TrimSpace(mime)
	if mime == "" || !strings.Contains(mime, "/") {
		if guessed := guessImageMIME(mime, data); guessed != "application/octet-stream" {
			mime = guessed
		}
	}
	return Picture{
		MIME:        mime,
		Type:        pt,
		Description: desc,
		Data:        data,
	}, true
}

func decodeASFWideNULTerminated(raw []byte) (string, int, bool) {
	for i := 0; i+1 < len(raw); i += 2 {
		if raw[i] == 0 && raw[i+1] == 0 {
			return decodeUTF16LE(raw[:i]), i + 2, true
		}
	}
	return "", 0, false
}

func asfTypeForName(name string) uint16 {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "wm/track", "wm/tracknumber", "wm/beatsperminute", "wm/partofset":
		return asfTypeDWord
	case "isvbr":
		return asfTypeBool
	case "wm/picture":
		return asfTypeBytes
	}
	return asfTypeUnicode
}

func decodeASFValue(valueType uint16, raw []byte) string {
	switch valueType {
	case 0:
		return decodeUTF16LE(raw)
	case 1:
		return ""
	case 2:
		if len(raw) >= 2 {
			if binary.LittleEndian.Uint16(raw) != 0 {
				return "1"
			}
			return "0"
		}
		if len(raw) >= 1 {
			if raw[0] != 0 {
				return "1"
			}
			return "0"
		}
	case 3:
		if len(raw) >= 4 {
			return strconv.FormatUint(uint64(binary.LittleEndian.Uint32(raw)), 10)
		}
	case 4:
		if len(raw) >= 8 {
			return strconv.FormatUint(binary.LittleEndian.Uint64(raw), 10)
		}
	case 5:
		if len(raw) >= 2 {
			return strconv.FormatUint(uint64(binary.LittleEndian.Uint16(raw)), 10)
		}
	case 6:
		if len(raw) >= 16 {
			var g [16]byte
			copy(g[:], raw[:16])
			return fmt.Sprintf("%X", g[:])
		}
	}
	return ""
}

func decodeUTF16LE(raw []byte) string {
	if len(raw) < 2 {
		return ""
	}
	if len(raw)%2 == 1 {
		raw = raw[:len(raw)-1]
	}
	u16 := make([]uint16, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		u16 = append(u16, binary.LittleEndian.Uint16(raw[i:]))
	}
	s := string(utf16.Decode(u16))
	return strings.TrimRight(s, "\x00")
}

func asfFieldFor(frameID string) []string {
	switch frameID {
	case id3v2.FrameTitle:
		return []string{"Title"}
	case id3v2.FrameArtist:
		return []string{"Author"}
	case id3v2.FrameAlbum:
		return []string{"WM/AlbumTitle"}
	case id3v2.FrameBand:
		return []string{"WM/AlbumArtist"}
	case id3v2.FrameComposer:
		return []string{"WM/Composer"}
	case id3v2.FrameYear, id3v2.FrameRecordingTime:
		return []string{"WM/Year"}
	case id3v2.FrameTrack:
		return []string{"WM/TrackNumber"}
	case id3v2.FramePart:
		return []string{"WM/PartOfSet"}
	case id3v2.FrameGenre:
		return []string{"WM/Genre"}
	case id3v2.FrameComment:
		return []string{"Description", "WM/Comments"}
	case id3v2.FrameCopyright:
		return []string{"Copyright"}
	case id3v2.FramePublisher:
		return []string{"WM/Publisher"}
	case id3v2.FrameBPM:
		return []string{"WM/BeatsPerMinute"}
	}
	return nil
}
