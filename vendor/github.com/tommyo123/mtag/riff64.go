package mtag

import (
	"encoding/binary"
	"io"
)

type riff64Info struct {
	dataSize uint64
	extra    map[string][]uint64
}

func isRF64Magic(magic [4]byte) bool {
	switch string(magic[:]) {
	case "RF64", "BW64":
		return true
	}
	return false
}

func readIFFOuterMagic(r io.ReaderAt) [4]byte {
	var magic [4]byte
	_, _ = r.ReadAt(magic[:], 0)
	return magic
}

func readRIFF64Info(r io.ReaderAt, size int64) *riff64Info {
	if size < 12+8 {
		return nil
	}
	var hdr [8]byte
	if _, err := r.ReadAt(hdr[:], 12); err != nil {
		return nil
	}
	if string(hdr[:4]) != "ds64" {
		return nil
	}
	bodySize := int64(binary.LittleEndian.Uint32(hdr[4:8]))
	if bodySize < 28 || 20+bodySize > size {
		return nil
	}
	body := make([]byte, bodySize)
	if _, err := r.ReadAt(body, 20); err != nil {
		return nil
	}
	out := &riff64Info{
		dataSize: binary.LittleEndian.Uint64(body[8:16]),
		extra:    map[string][]uint64{},
	}
	tableLen := int(binary.LittleEndian.Uint32(body[24:28]))
	cur := 28
	for i := 0; i < tableLen && cur+12 <= len(body); i++ {
		name := string(body[cur : cur+4])
		value := binary.LittleEndian.Uint64(body[cur+4 : cur+12])
		out.extra[name] = append(out.extra[name], value)
		cur += 12
	}
	return out
}

func resolveRIFF64ChunkSize(id [4]byte, size32 uint32, info *riff64Info, used map[string]int) (int64, bool) {
	if size32 != 0xFFFFFFFF {
		return int64(size32), true
	}
	if info == nil {
		return 0, false
	}
	name := string(id[:])
	if name == "data" && info.dataSize > 0 {
		return int64(info.dataSize), true
	}
	if vals := info.extra[name]; len(vals) > 0 {
		idx := used[name]
		if idx < len(vals) {
			used[name] = idx + 1
			return int64(vals[idx]), true
		}
	}
	return 0, false
}

func listIFFChunks(r io.ReaderAt, size int64, order binary.ByteOrder, outerMagic [4]byte) []chunkSpan {
	if !isRF64Magic(outerMagic) {
		return listChunks(r, size, order)
	}
	info := readRIFF64Info(r, size)
	used := map[string]int{}
	const minChunkHdr = 8
	var out []chunkSpan
	cursor := int64(12)
	for cursor+minChunkHdr <= size {
		var hdr [minChunkHdr]byte
		if _, err := r.ReadAt(hdr[:], cursor); err != nil {
			return out
		}
		var id [4]byte
		copy(id[:], hdr[:4])
		dataSize, ok := resolveRIFF64ChunkSize(id, order.Uint32(hdr[4:8]), info, used)
		if !ok {
			return out
		}
		dataStart := cursor + minChunkHdr
		if dataSize < 0 || dataStart+dataSize > size {
			return out
		}
		padded := dataSize
		if padded%2 == 1 {
			padded++
		}
		out = append(out, chunkSpan{
			ID:         id,
			HeaderAt:   cursor,
			DataAt:     dataStart,
			DataSize:   dataSize,
			PaddedSize: padded,
		})
		cursor = dataStart + padded
	}
	return out
}

func renderRIFF64DS64(riffSize, dataSize uint64, extra map[string]uint64) []byte {
	entryCount := len(extra)
	body := make([]byte, 28+entryCount*12)
	binary.LittleEndian.PutUint64(body[0:8], riffSize)
	binary.LittleEndian.PutUint64(body[8:16], dataSize)
	binary.LittleEndian.PutUint64(body[16:24], 0)
	binary.LittleEndian.PutUint32(body[24:28], uint32(entryCount))
	cur := 28
	for name, size64 := range extra {
		copy(body[cur:cur+4], []byte(name))
		binary.LittleEndian.PutUint64(body[cur+4:cur+12], size64)
		cur += 12
	}
	return body
}
