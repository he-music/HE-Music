// Adapted from github.com/guohuiyuan/music-lib/soda/crypto.go (AGPL-3.0).
package transform

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
)

// DecryptSamples 解密完整容器；inPlace 只允许调用方独占的缓冲区。
func DecryptSamples(data []byte, p Parameters, inPlace bool) ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if p.Kind != SampleCTR {
		return nil, errors.New("invalid sample transform")
	}
	return decryptAudio(data, p.Key, inPlace)
}

func decryptAudio(fileData, keyBytes []byte, inPlace bool) ([]byte, error) {
	moov, err := findBox(fileData, "moov", 0, len(fileData))
	if err != nil {
		return nil, errors.New("moov box not found")
	}

	stbl, err := findSampleTable(fileData, moov)
	if err != nil {
		return nil, err
	}

	stsz, err := findBox(fileData, "stsz", stbl.offset+stbl.headerSize, stbl.offset+stbl.size)
	if err != nil {
		return nil, errors.New("stsz box not found")
	}
	sampleSizes := parseStsz(stsz.data)
	if len(sampleSizes) == 0 {
		return nil, errors.New("invalid MP4 sample sizes")
	}

	senc, err := findBox(fileData, "senc", moov.offset+moov.headerSize, moov.offset+moov.size)
	if err != nil {
		senc, err = findBox(fileData, "senc", stbl.offset+stbl.headerSize, stbl.offset+stbl.size)
	}
	if err != nil {
		return nil, errors.New("senc box not found")
	}
	sencSamples := parseSenc(senc.data, defaultPerSampleIVSize(fileData, stbl.offset, stbl.offset+stbl.size))
	if len(sencSamples) != len(sampleSizes) {
		return nil, errors.New("invalid MP4 sample encryption table")
	}

	mdat, err := findBox(fileData, "mdat", 0, len(fileData))
	if err != nil {
		return nil, errors.New("mdat box not found")
	}

	block, err := aes.NewCipher(keyBytes)
	if err != nil {
		return nil, err
	}

	// 先校验全部样本边界，失败时不修改输入，也不复制整份无效文件。
	remaining := mdat.size - mdat.headerSize
	for _, size := range sampleSizes {
		if uint64(size) > uint64(remaining) {
			return nil, errors.New("MP4 sample exceeds audio data")
		}
		remaining -= int(size)
	}
	if remaining != 0 {
		return nil, errors.New("decrypted size mismatch")
	}

	decryptedData := fileData
	if !inPlace {
		decryptedData = bytes.Clone(fileData)
	}
	readPtr := mdat.offset + mdat.headerSize
	for i, size := range sampleSizes {
		chunk := decryptedData[readPtr : readPtr+int(size)]
		decryptSencSampleInto(block, chunk, chunk, &sencSamples[i])
		readPtr += int(size)
	}
	stsd, err := findBox(fileData, "stsd", stbl.offset+stbl.headerSize, stbl.offset+stbl.size)
	if err == nil {
		stsdOffset := stsd.offset
		stsdData := decryptedData[stsdOffset : stsdOffset+stsd.size]
		if idx := bytes.Index(stsdData, []byte("enca")); idx != -1 {
			copy(stsdData[idx:], encryptedSampleOriginalFormat(stsdData))
		}
	}

	return decryptedData, nil
}

func findSampleTable(fileData []byte, moov *mp4Box) (*mp4Box, error) {
	stbl, err := findBox(fileData, "stbl", moov.offset, moov.offset+moov.size)
	if err != nil {
		trak, _ := findBox(fileData, "trak", moov.offset+moov.headerSize, moov.offset+moov.size)
		if trak != nil {
			mdia, _ := findBox(fileData, "mdia", trak.offset+8, trak.offset+trak.size)
			if mdia != nil {
				minf, _ := findBox(fileData, "minf", mdia.offset+8, mdia.offset+mdia.size)
				if minf != nil {
					stbl, _ = findBox(fileData, "stbl", minf.offset+8, minf.offset+minf.size)
				}
			}
		}
	}
	if stbl == nil {
		return nil, errors.New("stbl box not found")
	}
	return stbl, nil
}

func encryptedSampleOriginalFormat(stsdData []byte) []byte {
	idx := bytes.Index(stsdData, []byte("frma"))
	if idx < 4 || idx+8 > len(stsdData) {
		return []byte("mp4a")
	}
	size := int(binary.BigEndian.Uint32(stsdData[idx-4 : idx]))
	if size < 12 || idx-4+size > len(stsdData) {
		return []byte("mp4a")
	}
	return stsdData[idx+4 : idx+8]
}

func defaultPerSampleIVSize(data []byte, start, end int) int {
	tenc, err := findBoxDeep(data, "tenc", start, end)
	if err != nil || len(tenc.data) < 8 {
		return 8
	}
	ivSize := int(tenc.data[7])
	if ivSize == 8 || ivSize == 16 {
		return ivSize
	}
	return 8
}

type encryptedSubsample struct {
	clear     uint16
	encrypted uint32
}

type encryptedSample struct {
	iv         [aes.BlockSize]byte
	subsamples []encryptedSubsample
}

func decryptSencSample(block cipher.Block, chunk []byte, sample encryptedSample) []byte {
	dst := make([]byte, len(chunk))
	decryptSencSampleInto(block, dst, chunk, &sample)
	return dst
}

func decryptSencSampleInto(block cipher.Block, dst, chunk []byte, sample *encryptedSample) {
	stream := cipher.NewCTR(block, sample.iv[:])
	if len(sample.subsamples) == 0 {
		stream.XORKeyStream(dst, chunk)
		return
	}

	pos := 0
	for _, sub := range sample.subsamples {
		clearBytes := min(int(sub.clear), len(chunk)-pos)
		copy(dst[pos:pos+clearBytes], chunk[pos:pos+clearBytes])
		pos += clearBytes
		if pos >= len(chunk) {
			break
		}

		encryptedBytes := int(min(uint64(sub.encrypted), uint64(len(chunk)-pos)))
		stream.XORKeyStream(dst[pos:pos+encryptedBytes], chunk[pos:pos+encryptedBytes])
		pos += encryptedBytes
		if pos >= len(chunk) {
			break
		}
	}
	if pos < len(chunk) {
		copy(dst[pos:], chunk[pos:])
	}
}

type mp4Box struct {
	offset     int
	headerSize int
	size       int
	data       []byte
}

func findBox(data []byte, boxType string, start, end int) (*mp4Box, error) {
	return findBoxDeep(data, boxType, start, end)
}

func findBoxDeep(data []byte, boxType string, start, end int) (*mp4Box, error) {
	return findBoxDepth(data, boxType, start, end, 0)
}

func findBoxDepth(data []byte, boxType string, start, end, depth int) (*mp4Box, error) {
	if depth > 32 {
		return nil, errors.New("MP4 box nesting exceeds 32 levels")
	}
	if start < 0 || end < start {
		return nil, errors.New("invalid MP4 box bounds")
	}
	if end > len(data) {
		end = len(data)
	}
	pos := start
	target := []byte(boxType)
	for pos+8 <= end {
		size := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		headerSize := 8
		if size == 1 {
			if pos+16 > end {
				break
			}
			size64 := binary.BigEndian.Uint64(data[pos+8 : pos+16])
			if size64 > uint64(end-pos) {
				break
			}
			size = int(size64)
			headerSize = 16
		}
		if size == 0 {
			size = end - pos
		}
		if size < headerSize || size > end-pos {
			break
		}
		currentType := string(data[pos+4 : pos+8])
		if bytes.Equal(data[pos+4:pos+8], target) {
			return &mp4Box{offset: pos, size: size, headerSize: headerSize, data: data[pos+headerSize : pos+size]}, nil
		}

		if childStart, ok := boxChildStart(currentType, pos, headerSize); ok && childStart < pos+size {
			if found, err := findBoxDepth(data, boxType, childStart, pos+size, depth+1); err == nil {
				return found, nil
			}
		}
		pos += size
	}
	return nil, errors.New("box not found")
}

func boxChildStart(boxType string, offset, headerSize int) (int, bool) {
	switch boxType {
	case "moov", "trak", "mdia", "minf", "stbl", "sinf", "schi":
		return offset + headerSize, true
	case "stsd":
		return offset + headerSize + 8, true
	case "enca", "mp4a", "alac", "fLaC":
		return offset + headerSize + 28, true
	default:
		return 0, false
	}
}

func parseStsz(data []byte) []uint32 {
	if len(data) < 12 {
		return nil
	}
	sampleSizeFixed := binary.BigEndian.Uint32(data[4:8])
	sampleCount := int(binary.BigEndian.Uint32(data[8:12]))
	if sampleCount < 0 || sampleCount > 1<<20 || (sampleSizeFixed == 0 && sampleCount > (len(data)-12)/4) {
		return nil
	}
	sizes := make([]uint32, sampleCount)
	if sampleSizeFixed != 0 {
		for i := range sampleCount {
			sizes[i] = sampleSizeFixed
		}
	} else {
		for i := range sampleCount {
			if 12+i*4+4 <= len(data) {
				sizes[i] = binary.BigEndian.Uint32(data[12+i*4 : 12+i*4+4])
			}
		}
	}
	return sizes
}

func parseSenc(data []byte, ivSize int) []encryptedSample {
	if len(data) < 8 {
		return nil
	}
	if ivSize != 8 && ivSize != 16 {
		ivSize = 8
	}
	flags := binary.BigEndian.Uint32(data[0:4]) & 0x00FFFFFF
	sampleCount := int(binary.BigEndian.Uint32(data[4:8]))
	if sampleCount < 0 || sampleCount > (len(data)-8)/ivSize || sampleCount > 1<<20 {
		return nil
	}
	samples := make([]encryptedSample, 0, sampleCount)
	ptr := 8
	hasSubsamples := (flags & 0x02) != 0
	for range sampleCount {
		if ptr+ivSize > len(data) {
			break
		}
		var sample encryptedSample
		copy(sample.iv[:], data[ptr:ptr+ivSize])
		ptr += ivSize
		if hasSubsamples {
			if ptr+2 > len(data) {
				break
			}
			subCount := int(binary.BigEndian.Uint16(data[ptr : ptr+2]))
			ptr += 2
			if ptr+subCount*6 > len(data) {
				break
			}
			sample.subsamples = make([]encryptedSubsample, 0, subCount)
			for range subCount {
				sample.subsamples = append(sample.subsamples, encryptedSubsample{
					clear:     binary.BigEndian.Uint16(data[ptr : ptr+2]),
					encrypted: binary.BigEndian.Uint32(data[ptr+2 : ptr+6]),
				})
				ptr += 6
			}
		}
		samples = append(samples, sample)
	}
	return samples
}
