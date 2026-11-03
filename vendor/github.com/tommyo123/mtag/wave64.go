package mtag

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf16"
)

var (
	w64GUIDRIFF    = [16]byte{'r', 'i', 'f', 'f', 0x2E, 0x91, 0xCF, 0x11, 0xA5, 0xD6, 0x28, 0xDB, 0x04, 0xC1, 0x00, 0x00}
	w64GUIDWAVE    = [16]byte{'w', 'a', 'v', 'e', 0xF3, 0xAC, 0xD3, 0x11, 0x8C, 0xD1, 0x00, 0xC0, 0x4F, 0x8E, 0xDB, 0x8A}
	w64GUIDFmt     = [16]byte{'f', 'm', 't', ' ', 0xF3, 0xAC, 0xD3, 0x11, 0x8C, 0xD1, 0x00, 0xC0, 0x4F, 0x8E, 0xDB, 0x8A}
	w64GUIDFact    = [16]byte{'f', 'a', 'c', 't', 0xF3, 0xAC, 0xD3, 0x11, 0x8C, 0xD1, 0x00, 0xC0, 0x4F, 0x8E, 0xDB, 0x8A}
	w64GUIDData    = [16]byte{'d', 'a', 't', 'a', 0xF3, 0xAC, 0xD3, 0x11, 0x8C, 0xD1, 0x00, 0xC0, 0x4F, 0x8E, 0xDB, 0x8A}
	w64GUIDSummary = [16]byte{0xBC, 0x94, 0x5F, 0x92, 0x5A, 0x52, 0xD2, 0x11, 0x86, 0xDC, 0x00, 0xC0, 0x4F, 0x8E, 0xDB, 0x8A}
)

type wave64Chunk struct {
	GUID      [16]byte
	HeaderAt  int64
	DataAt    int64
	DataSize  int64
	TotalSize int64
	Padded    int64
}

func isWave64FileHeader(head []byte) bool {
	if len(head) < 40 {
		return false
	}
	return bytes.Equal(head[:16], w64GUIDRIFF[:]) && bytes.Equal(head[24:40], w64GUIDWAVE[:])
}

func align8(n int64) int64 {
	return (n + 7) &^ 7
}

func listWave64Chunks(r io.ReaderAt, size int64) []wave64Chunk {
	if size < 40 {
		return nil
	}
	var head [40]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil
	}
	if !isWave64FileHeader(head[:]) {
		return nil
	}
	var out []wave64Chunk
	for cursor := int64(40); cursor+24 <= size; {
		var hdr [24]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			return out
		}
		chunkSize := int64(binary.LittleEndian.Uint64(hdr[16:24]))
		if chunkSize < 24 || cursor+chunkSize > size {
			return out
		}
		var guid [16]byte
		copy(guid[:], hdr[:16])
		out = append(out, wave64Chunk{
			GUID:      guid,
			HeaderAt:  cursor,
			DataAt:    cursor + 24,
			DataSize:  chunkSize - 24,
			TotalSize: chunkSize,
			Padded:    align8(chunkSize),
		})
		cursor += align8(chunkSize)
	}
	return out
}

func scanW64Info(r io.ReaderAt, size int64) *riffInfoView {
	for _, chunk := range listWave64Chunks(r, size) {
		if chunk.GUID != w64GUIDSummary {
			continue
		}
		body := make([]byte, chunk.DataSize)
		if _, err := r.ReadAt(body, chunk.DataAt); err != nil {
			return nil
		}
		return parseW64SummaryList(body)
	}
	return nil
}

func parseW64SummaryList(body []byte) *riffInfoView {
	if len(body) < 4 {
		return nil
	}
	count := int(binary.LittleEndian.Uint32(body[:4]))
	cur := 4
	out := &riffInfoView{kind: ContainerW64, values: map[string]string{}}
	for i := 0; i < count && cur+8 <= len(body); i++ {
		key := string(body[cur : cur+4])
		size := int(binary.LittleEndian.Uint32(body[cur+4 : cur+8]))
		cur += 8
		if size < 0 || cur+size > len(body) {
			break
		}
		value := trimW64Text(body[cur : cur+size])
		name := strings.ToUpper(key)
		if _, seen := out.values[name]; !seen {
			out.keys = append(out.keys, name)
		}
		out.values[name] = value
		cur += size
	}
	if len(out.keys) == 0 {
		return nil
	}
	return out
}

func trimW64Text(b []byte) string {
	if len(b)%2 == 1 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		v := binary.LittleEndian.Uint16(b[i : i+2])
		if v == 0 {
			break
		}
		u = append(u, v)
	}
	return strings.TrimRight(string(utf16.Decode(u)), " \t\r\n")
}

func encodeW64SummaryList(v *riffInfoView) []byte {
	if v == nil {
		return nil
	}
	var body bytes.Buffer
	var count int
	body.Write([]byte{0, 0, 0, 0})
	for _, key := range v.keys {
		if !isRIFFInfoKey(key) {
			continue
		}
		value := v.values[key]
		if value == "" {
			continue
		}
		encoded := encodeUTF16LEString(value)
		body.WriteString(key)
		var size [4]byte
		binary.LittleEndian.PutUint32(size[:], uint32(len(encoded)))
		body.Write(size[:])
		body.Write(encoded)
		count++
	}
	if count == 0 {
		return nil
	}
	raw := body.Bytes()
	binary.LittleEndian.PutUint32(raw[:4], uint32(count))
	return raw
}

func encodeUTF16LEString(s string) []byte {
	u := utf16.Encode([]rune(s))
	out := make([]byte, 0, len(u)*2+2)
	for _, v := range u {
		var buf [2]byte
		binary.LittleEndian.PutUint16(buf[:], v)
		out = append(out, buf[:]...)
	}
	out = append(out, 0, 0)
	return out
}

func writeWave64Chunk(w io.Writer, guid [16]byte, body []byte) error {
	if _, err := w.Write(guid[:]); err != nil {
		return err
	}
	var size [8]byte
	binary.LittleEndian.PutUint64(size[:], uint64(24+len(body)))
	if _, err := w.Write(size[:]); err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := w.Write(body); err != nil {
			return err
		}
	}
	for pad := align8(int64(24+len(body))) - int64(24+len(body)); pad > 0; pad-- {
		if _, err := w.Write([]byte{0}); err != nil {
			return err
		}
	}
	return nil
}

func (f *File) saveW64Container() error {
	if f.container.Kind() != ContainerW64 {
		return fmt.Errorf("mtag: saveW64Container called on %v", f.container.Kind())
	}
	chunks := listWave64Chunks(f.src, f.size)
	if len(chunks) == 0 {
		return fmt.Errorf("mtag: invalid Wave64 stream")
	}
	nativeDirty := f.riffInfo != nil && f.riffInfo.dirty
	type planned struct {
		guid   [16]byte
		source *wave64Chunk
		body   []byte
	}
	var plan []planned
	wroteSummary := false
	emitSummary := func() {
		if !nativeDirty || wroteSummary {
			return
		}
		wroteSummary = true
		if body := encodeW64SummaryList(f.riffInfo); body != nil {
			plan = append(plan, planned{guid: w64GUIDSummary, body: body})
		}
	}
	for i := range chunks {
		chunk := &chunks[i]
		if chunk.GUID == w64GUIDSummary {
			emitSummary()
			continue
		}
		plan = append(plan, planned{guid: chunk.GUID, source: chunk})
	}
	emitSummary()

	fileSize := int64(40)
	for _, p := range plan {
		bodyLen := int64(len(p.body))
		if p.source != nil {
			bodyLen = p.source.DataSize
		}
		fileSize += align8(24 + bodyLen)
	}

	writeAll := func(w io.Writer) error {
		if _, err := w.Write(w64GUIDRIFF[:]); err != nil {
			return err
		}
		var size [8]byte
		binary.LittleEndian.PutUint64(size[:], uint64(fileSize))
		if _, err := w.Write(size[:]); err != nil {
			return err
		}
		if _, err := w.Write(w64GUIDWAVE[:]); err != nil {
			return err
		}
		for _, p := range plan {
			if p.source != nil {
				if _, err := w.Write(p.guid[:]); err != nil {
					return err
				}
				var chunkSize [8]byte
				binary.LittleEndian.PutUint64(chunkSize[:], uint64(24+p.source.DataSize))
				if _, err := w.Write(chunkSize[:]); err != nil {
					return err
				}
				if err := copyRangeCtx(f.saveCtx, w, f.src, p.source.DataAt, p.source.DataSize); err != nil {
					return err
				}
				for pad := p.source.Padded - p.source.TotalSize; pad > 0; pad-- {
					if _, err := w.Write([]byte{0}); err != nil {
						return err
					}
				}
				continue
			}
			if err := writeWave64Chunk(w, p.guid, p.body); err != nil {
				return err
			}
		}
		return nil
	}

	if f.path == "" {
		return f.rewriteWritableFromTemp(func(tmp *os.File) error { return writeAll(tmp) })
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
	if err := writeAll(tmp); err != nil {
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
	if info, err := reopen.Stat(); err == nil {
		f.size = info.Size()
	}
	return nil
}
