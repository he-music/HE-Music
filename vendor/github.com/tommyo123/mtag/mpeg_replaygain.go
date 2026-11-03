package mtag

import (
	"encoding/binary"
	"math"
	"strings"
)

type mpegSummaryLayout struct {
	tagPos  int
	flags   uint32
	dataPos int
}

type mpegLameReplayGain struct {
	track      ReplayGain
	trackFound bool
	album      ReplayGain
	albumFound bool
}

func locateMPEGSummary(frame []byte) (mpegSummaryLayout, bool) {
	if len(frame) < 8 {
		return mpegSummaryLayout{}, false
	}
	if pos, ok := expectedMPEGSummaryOffset(frame); ok && pos >= 0 && pos+8 <= len(frame) {
		tag := string(frame[pos : pos+4])
		if tag == "Xing" || tag == "Info" {
			flags := binary.BigEndian.Uint32(frame[pos+4 : pos+8])
			dataPos := pos + 8
			if flags&0x01 != 0 {
				dataPos += 4
			}
			if flags&0x02 != 0 {
				dataPos += 4
			}
			if flags&0x04 != 0 {
				dataPos += 100
			}
			if flags&0x08 != 0 {
				dataPos += 4
			}
			if dataPos <= len(frame) {
				return mpegSummaryLayout{tagPos: pos, flags: flags, dataPos: dataPos}, true
			}
		}
	}

	idx := strings.Index(string(frame), "Xing")
	if idx < 0 {
		idx = strings.Index(string(frame), "Info")
	}
	if idx < 0 || len(frame) < idx+8 {
		return mpegSummaryLayout{}, false
	}
	flags := binary.BigEndian.Uint32(frame[idx+4 : idx+8])
	dataPos := idx + 8
	if flags&0x01 != 0 {
		dataPos += 4
	}
	if flags&0x02 != 0 {
		dataPos += 4
	}
	if flags&0x04 != 0 {
		dataPos += 100
	}
	if flags&0x08 != 0 {
		dataPos += 4
	}
	if dataPos > len(frame) {
		return mpegSummaryLayout{}, false
	}
	return mpegSummaryLayout{tagPos: idx, flags: flags, dataPos: dataPos}, true
}

func expectedMPEGSummaryOffset(frame []byte) (int, bool) {
	if len(frame) < 4 {
		return 0, false
	}
	hdr := binary.BigEndian.Uint32(frame[:4])
	if hdr&0xFFE00000 != 0xFFE00000 {
		return 0, false
	}
	versionBits := (hdr >> 19) & 0x3
	layerBits := (hdr >> 17) & 0x3
	if versionBits == 0x1 || layerBits != 0x1 {
		return 0, false
	}
	lsf := versionBits != 0x3
	mono := ((hdr >> 6) & 0x3) == 0x3
	switch {
	case !lsf && !mono:
		return 4 + 32, true
	case !lsf && mono:
		return 4 + 17, true
	case lsf && !mono:
		return 4 + 17, true
	default:
		return 4 + 9, true
	}
}

func (f *File) replayGainFromMPEGLame(scope string) (ReplayGain, bool) {
	empty := ReplayGain{Gain: math.NaN(), Peak: math.NaN()}
	if f.Container() != ContainerMP3 || f.src == nil {
		return empty, false
	}

	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}

	offset, first, ok := findNextMPEGFrame(f.src, start, end)
	if !ok || first.codec != "mp3" || first.frameLen <= 0 || first.frameLen > 16384 {
		return empty, false
	}

	frame, err := readRange(f.src, offset, int64(first.frameLen))
	if err != nil {
		return empty, false
	}
	info, ok := parseMPEGLameReplayGain(frame)
	if !ok {
		return empty, false
	}

	switch strings.ToUpper(strings.TrimSpace(scope)) {
	case "ALBUM":
		return info.album, info.albumFound
	default:
		return info.track, info.trackFound
	}
}

func parseMPEGLameReplayGain(frame []byte) (mpegLameReplayGain, bool) {
	layout, ok := locateMPEGSummary(frame)
	if !ok || len(frame) < layout.dataPos+36 {
		return mpegLameReplayGain{}, false
	}

	crcPos := layout.dataPos + 34
	if mpegLameCRC(frame[:crcPos]) != binary.BigEndian.Uint16(frame[crcPos:crcPos+2]) {
		return mpegLameReplayGain{}, false
	}

	out := mpegLameReplayGain{
		track: ReplayGain{Gain: math.NaN(), Peak: math.NaN()},
		album: ReplayGain{Gain: math.NaN(), Peak: math.NaN()},
	}
	if peakRaw := binary.BigEndian.Uint32(frame[layout.dataPos+11 : layout.dataPos+15]); peakRaw != 0 {
		out.track.Peak = float64(peakRaw) / float64(1<<23)
		out.trackFound = true
	}
	if gain, ok := parseMPEGLameGain(binary.BigEndian.Uint16(frame[layout.dataPos+15:layout.dataPos+17]), 1); ok {
		out.track.Gain = gain
		out.trackFound = true
	}
	if gain, ok := parseMPEGLameGain(binary.BigEndian.Uint16(frame[layout.dataPos+17:layout.dataPos+19]), 2); ok {
		out.album.Gain = gain
		out.albumFound = true
	}
	return out, out.trackFound || out.albumFound
}

func parseMPEGLameGain(raw uint16, kind uint16) (float64, bool) {
	if (raw>>13)&0x7 != kind {
		return 0, false
	}
	gain := float64(raw&0x01FF) / 10.0
	if raw&(1<<9) != 0 {
		gain = -gain
	}
	return gain, true
}

func mpegLameCRC(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}

func encodeMPEGLameGain(gain float64, kind uint16) uint16 {
	if math.IsNaN(gain) {
		return 0
	}
	value := uint16(math.Round(math.Abs(gain) * 10))
	if value > 0x01FF {
		value = 0x01FF
	}
	if gain < 0 {
		value |= 1 << 9
	}
	return (kind << 13) | value
}

func encodeMPEGLamePeak(peak float64) uint32 {
	if math.IsNaN(peak) || peak <= 0 {
		return 0
	}
	raw := math.Round(peak * float64(1<<23))
	if raw < 0 {
		return 0
	}
	if raw > float64(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(raw)
}

func (f *File) stageMPEGLameReplayGain(scope string, rg ReplayGain) {
	if f.Container() != ContainerMP3 {
		return
	}
	if !f.mpegReplayGainDirty {
		f.mpegReplayGain = mpegLameReplayGain{
			track: ReplayGain{Gain: math.NaN(), Peak: math.NaN()},
			album: ReplayGain{Gain: math.NaN(), Peak: math.NaN()},
		}
		if track, ok := f.replayGainFromMPEGLame("TRACK"); ok {
			f.mpegReplayGain.track = track
			f.mpegReplayGain.trackFound = true
		}
		if album, ok := f.replayGainFromMPEGLame("ALBUM"); ok {
			f.mpegReplayGain.album = album
			f.mpegReplayGain.albumFound = true
		}
	}
	switch strings.ToUpper(strings.TrimSpace(scope)) {
	case "ALBUM":
		f.mpegReplayGain.album = rg
		f.mpegReplayGain.albumFound = !math.IsNaN(rg.Gain)
	default:
		f.mpegReplayGain.track = rg
		f.mpegReplayGain.trackFound = !math.IsNaN(rg.Gain) || !math.IsNaN(rg.Peak)
	}
	f.mpegReplayGainDirty = true
}

func (f *File) writeMPEGLameReplayGain() error {
	if f.Container() != ContainerMP3 || !f.mpegReplayGainDirty || f.src == nil {
		return nil
	}
	start := f.v2at + f.v2size
	if start < 0 || start >= f.size {
		start = 0
	}
	end := f.size
	if v1Offset := f.v1At(); v1Offset > start {
		end = v1Offset
	}
	offset, first, ok := findNextMPEGFrame(f.src, start, end)
	if !ok || first.codec != "mp3" || first.frameLen <= 0 || first.frameLen > 16384 {
		return nil
	}
	frame, err := readRange(f.src, offset, int64(first.frameLen))
	if err != nil {
		return err
	}
	layout, ok := locateMPEGSummary(frame)
	if !ok || len(frame) < layout.dataPos+36 {
		return nil
	}
	binary.BigEndian.PutUint32(frame[layout.dataPos+11:layout.dataPos+15], encodeMPEGLamePeak(f.mpegReplayGain.track.Peak))
	binary.BigEndian.PutUint16(frame[layout.dataPos+15:layout.dataPos+17], encodeMPEGLameGain(f.mpegReplayGain.track.Gain, 1))
	binary.BigEndian.PutUint16(frame[layout.dataPos+17:layout.dataPos+19], encodeMPEGLameGain(f.mpegReplayGain.album.Gain, 2))
	crcPos := layout.dataPos + 34
	binary.BigEndian.PutUint16(frame[crcPos:crcPos+2], mpegLameCRC(frame[:crcPos]))
	fd, err := f.writable()
	if err != nil {
		return err
	}
	if _, err := fd.WriteAt(frame, offset); err != nil {
		return err
	}
	f.mpegReplayGainDirty = false
	return nil
}
