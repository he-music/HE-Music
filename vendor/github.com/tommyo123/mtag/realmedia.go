package mtag

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/tommyo123/mtag/id3v2"
)

const maxRealMediaObjectBytes = 4 << 20

type realMediaField struct {
	Name  string
	Value string
}

type realMediaView struct {
	Fields []realMediaField
}

type realMediaObject struct {
	ID      string
	Offset  int64
	Size    int64
	Version uint16
}

func (v *realMediaView) add(name, value string) {
	if v == nil || name == "" || value == "" {
		return
	}
	v.Fields = append(v.Fields, realMediaField{Name: name, Value: value})
}

func (v *realMediaView) Get(name string) string {
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

func (v *realMediaView) GetAll(name string) []string {
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

func (v *realMediaView) Set(name, value string) {
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
		v.Fields = append(v.Fields, realMediaField{Name: name, Value: value})
	}
}

func (f *File) detectRealMedia() error {
	view, err := readRealMediaMetadata(f.src, f.size)
	if err != nil {
		return err
	}
	f.realMedia = view
	return nil
}

func readRealMediaMetadata(r io.ReaderAt, size int64) (*realMediaView, error) {
	if size < 18 {
		if size >= 8 {
			var short [8]byte
			if _, err := r.ReadAt(short[:], 0); err == nil && string(short[:4]) == ".ra\xfd" {
				return nil, nil
			}
		}
		return nil, fmt.Errorf("realmedia: short file")
	}
	var head [18]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	if string(head[:4]) == ".ra\xfd" {
		return nil, nil
	}
	if string(head[:4]) != ".RMF" {
		return nil, fmt.Errorf("realmedia: bad header")
	}
	headerSize := int64(binary.BigEndian.Uint32(head[4:8]))
	if headerSize < 18 || headerSize > size {
		headerSize = 18
	}
	view := &realMediaView{}
	for off := headerSize; off+10 <= size; {
		var objHead [10]byte
		if _, err := r.ReadAt(objHead[:], off); err != nil {
			break
		}
		objID := string(objHead[:4])
		objSize := int64(binary.BigEndian.Uint32(objHead[4:8]))
		if objSize < 10 || off+objSize > size {
			break
		}
		if objSize-10 > maxRealMediaObjectBytes {
			if objID == "DATA" {
				break
			}
			off += objSize
			continue
		}
		if objID == "CONT" {
			body := make([]byte, objSize-10)
			if len(body) > 0 {
				if _, err := r.ReadAt(body, off+10); err == nil {
					parseRealMediaCONT(view, body)
				}
			}
		}
		if objID == "DATA" {
			break
		}
		off += objSize
	}
	if len(view.Fields) == 0 {
		return nil, nil
	}
	return view, nil
}

func parseRealMediaCONT(v *realMediaView, body []byte) {
	cur := 0
	readString := func() string {
		if cur+2 > len(body) {
			return ""
		}
		n := int(binary.BigEndian.Uint16(body[cur:]))
		cur += 2
		if n < 0 || cur+n > len(body) {
			cur = len(body)
			return ""
		}
		s := strings.TrimRight(string(body[cur:cur+n]), "\x00 ")
		cur += n
		return s
	}
	if s := readString(); s != "" {
		v.add("Title", s)
	}
	if s := readString(); s != "" {
		v.add("Author", s)
	}
	if s := readString(); s != "" {
		v.add("Copyright", s)
	}
	if s := readString(); s != "" {
		v.add("Comment", s)
	}
}

func encodeRealMediaText(s string) ([]byte, bool, bool) {
	const maxLen = 0xFFFF
	out, truncated, substituted := truncateLatinWithReport(s, maxLen)
	return []byte(out), truncated, substituted
}

func renderRealMediaCONT(v *realMediaView) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	fields := []string{
		v.Get("Title"),
		v.Get("Author"),
		v.Get("Copyright"),
		v.Get("Comment"),
	}
	any := false
	var payload bytes.Buffer
	payload.Write([]byte("CONT"))
	payload.Write(make([]byte, 4))
	payload.Write([]byte{0, 0})
	for _, s := range fields {
		if s != "" {
			any = true
		}
		raw, _, _ := encodeRealMediaText(s)
		if len(raw) > 0xFFFF {
			return nil, fmt.Errorf("realmedia: field too large")
		}
		var lenBuf [2]byte
		binary.BigEndian.PutUint16(lenBuf[:], uint16(len(raw)))
		payload.Write(lenBuf[:])
		payload.Write(raw)
	}
	if !any {
		return nil, nil
	}
	out := payload.Bytes()
	binary.BigEndian.PutUint32(out[4:8], uint32(len(out)))
	return out, nil
}

func scanRealMediaObjects(r io.ReaderAt, size int64) (headerSize int64, headerCount int, objs []realMediaObject, err error) {
	if size < 18 {
		return 0, 0, nil, fmt.Errorf("realmedia: short file")
	}
	var head [18]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return 0, 0, nil, err
	}
	if string(head[:4]) != ".RMF" {
		return 0, 0, nil, fmt.Errorf("realmedia: bad header")
	}
	headerSize = int64(binary.BigEndian.Uint32(head[4:8]))
	if headerSize < 18 || headerSize > size {
		headerSize = 18
	}
	if headerSize >= 4 {
		var countBuf [4]byte
		if _, err := r.ReadAt(countBuf[:], headerSize-4); err == nil {
			headerCount = int(binary.BigEndian.Uint32(countBuf[:]))
		}
	}
	for off, seen := headerSize, 0; off+10 <= size; {
		if headerCount > 0 && seen >= headerCount {
			break
		}
		var objHead [10]byte
		if _, err := r.ReadAt(objHead[:], off); err != nil {
			return headerSize, headerCount, objs, err
		}
		objSize := int64(binary.BigEndian.Uint32(objHead[4:8]))
		if objSize < 10 || off+objSize > size {
			return headerSize, headerCount, objs, fmt.Errorf("realmedia: bad object size for %q", string(objHead[:4]))
		}
		objs = append(objs, realMediaObject{
			ID:      string(objHead[:4]),
			Offset:  off,
			Size:    objSize,
			Version: binary.BigEndian.Uint16(objHead[8:10]),
		})
		off += objSize
		seen++
	}
	return headerSize, headerCount, objs, nil
}

func (f *File) saveRealMedia() error {
	_, err := f.writable()
	if err != nil {
		return err
	}
	headerSize, headerCount, objs, err := scanRealMediaObjects(f.src, f.size)
	if err != nil {
		return err
	}
	newCONT, err := renderRealMediaCONT(f.realMedia)
	if err != nil {
		return err
	}
	var dataObj *realMediaObject
	haveCONT := false
	for i := range objs {
		if objs[i].ID == "DATA" && dataObj == nil {
			dataObj = &objs[i]
		}
		if objs[i].ID == "CONT" {
			haveCONT = true
		}
	}
	if dataObj == nil {
		return fmt.Errorf("realmedia: DATA object missing")
	}
	if !haveCONT && len(newCONT) == 0 {
		return nil
	}

	var prefix bytes.Buffer
	rmfHead := make([]byte, headerSize)
	if _, err := f.src.ReadAt(rmfHead, 0); err != nil {
		return err
	}
	prefix.Write(rmfHead)
	for _, obj := range objs {
		if obj.Offset >= dataObj.Offset {
			break
		}
		if obj.ID == "CONT" {
			continue
		}
		if err := copyRange(&prefix, f.src, obj.Offset, obj.Size); err != nil {
			return err
		}
	}
	if len(newCONT) > 0 {
		prefix.Write(newCONT)
	}
	newCount := headerCount
	switch {
	case haveCONT && len(newCONT) == 0:
		newCount--
	case !haveCONT && len(newCONT) > 0:
		newCount++
	}
	if headerSize >= 18 {
		binary.BigEndian.PutUint32(prefix.Bytes()[headerSize-4:headerSize], uint32(newCount))
	}

	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error {
			if _, err := tmp.Write(prefix.Bytes()); err != nil {
				return err
			}
			if err := copyRangeCtx(f.saveCtx, tmp, f.src, dataObj.Offset, f.size-dataObj.Offset); err != nil {
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
	if _, err := tmp.Write(prefix.Bytes()); err != nil {
		cleanup()
		return err
	}
	if err := copyRangeCtx(f.saveCtx, tmp, f.src, dataObj.Offset, f.size-dataObj.Offset); err != nil {
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

func realMediaFieldFor(frameID string) []string {
	switch frameID {
	case id3v2.FrameTitle:
		return []string{"Title"}
	case id3v2.FrameArtist:
		return []string{"Author"}
	case id3v2.FrameComment:
		return []string{"Comment"}
	case id3v2.FrameCopyright:
		return []string{"Copyright"}
	}
	return nil
}

type realMediaTagView struct{ v *realMediaView }

func (v *realMediaTagView) Kind() TagKind { return TagRealMedia }

func (v *realMediaTagView) Keys() []string {
	if v.v == nil {
		return nil
	}
	out := make([]string, 0, len(v.v.Fields))
	seen := make(map[string]bool, len(v.v.Fields))
	for _, f := range v.v.Fields {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}

func (v *realMediaTagView) Get(name string) string { return v.v.Get(name) }
