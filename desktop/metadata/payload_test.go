package metadata

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func payloadCompare(a, b []byte) error {
	return CompareAudioPayload(context.Background(), bytes.NewReader(a), int64(len(a)), bytes.NewReader(b), int64(len(b)))
}
func payloadMP3() []byte {
	// MPEG-1 Layer III, 128 kbps, 44100 Hz, stereo, no CRC; two
	// complete frames with zero side information and zero-length granules.
	frame := make([]byte, 417)
	copy(frame, []byte{0xff, 0xfb, 0x90, 0})
	return bytes.Repeat(frame, 2)
}
func payloadID3(version, flags byte, body []byte) []byte {
	n := len(body)
	h := []byte{'I', 'D', '3', version, 0, flags, byte(n>>21) & 127, byte(n>>14) & 127, byte(n>>7) & 127, byte(n) & 127}
	out := append(append([]byte{}, h...), body...)
	if flags&16 != 0 {
		h[0], h[1], h[2] = '3', 'D', 'I'
		out = append(out, h...)
	}
	return out
}
func payloadCRC(data []byte, width uint, poly uint32) uint32 {
	var crc uint32
	for _, v := range data {
		crc ^= uint32(v) << (width - 8)
		for i := 0; i < 8; i++ {
			if crc&(1<<(width-1)) != 0 {
				crc = crc<<1 ^ poly
			} else {
				crc <<= 1
			}
		}
	}
	return crc & ((1 << width) - 1)
}
func payloadFLAC() []byte {
	// A complete native mono 16-bit FLAC constant subframe, 16 samples.
	info := make([]byte, 34)
	binary.BigEndian.PutUint16(info[:2], 16)
	binary.BigEndian.PutUint16(info[2:4], 16)
	binary.BigEndian.PutUint64(info[10:18], uint64(44100)<<44|uint64(15)<<36|16)
	frame := []byte{0xff, 0xf8, 0x69, 0x08, 0, 15}
	frame = append(frame, byte(payloadCRC(frame, 8, 7)))
	frame = append(frame, 0, 0, 0)
	crc := payloadCRC(frame, 16, 0x8005)
	frame = append(frame, byte(crc>>8), byte(crc))
	out := append([]byte("fLaC\x80\x00\x00\x22"), info...)
	return append(out, frame...)
}
func TestPayloadPureLayouts(t *testing.T) {
	mp3, flac := payloadMP3(), payloadFLAC()
	for name, data := range map[string][]byte{"mpeg": mp3, "flac": flac, "id3v23": append(payloadID3(3, 0, []byte("tags")), mp3...), "id3v24footer": append(payloadID3(4, 16, []byte("tags")), mp3...)} {
		t.Run(name, func(t *testing.T) {
			if err := payloadCompare(data, data); err != nil {
				t.Fatal(err)
			}
		})
	}
	v1 := make([]byte, 128)
	copy(v1, "TAG")
	if err := payloadCompare(mp3, append(append([]byte{}, mp3...), v1...)); err != nil {
		t.Fatal(err)
	}
	// Changes to every byte of the audio span must fail, including the first
	// frame (Xing/Info/LAME bytes are never treated as dispensable metadata).
	for name, data := range map[string][]byte{"mp3": mp3, "flac": flac} {
		span, err := inspectPayload(payloadSource{context.Background(), bytes.NewReader(data), int64(len(data))})
		if err != nil {
			t.Fatal(err)
		}
		for i := span.start; i < span.end; i++ {
			changed := bytes.Clone(data)
			changed[i] ^= 1
			if err := payloadCompare(data, changed); err == nil {
				t.Fatalf("%s audio byte %d accepted", name, i)
			}
		}
	}
	changed := bytes.Clone(mp3)
	copy(changed[40:], "XingLAME")
	if !errors.Is(payloadCompare(mp3, changed), ErrAudioPayloadChanged) {
		t.Fatal("first frame must be compared")
	}
	tagged := append(payloadID3(4, 0, []byte("new metadata")), mp3...)
	if err := payloadCompare(mp3, tagged); err != nil {
		t.Fatal(err)
	}
	taggedFLAC := append([]byte{}, flac[:42]...)
	taggedFLAC[4] = 0
	taggedFLAC = append(taggedFLAC, 0x81, 0, 0, 5, 0, 0, 0, 0, 0)
	taggedFLAC = append(taggedFLAC, flac[42:]...)
	if err := payloadCompare(flac, taggedFLAC); err != nil {
		t.Fatal(err)
	}
}

func TestPayloadRejectedLayouts(t *testing.T) {
	mp3, flac := payloadMP3(), payloadFLAC()
	cases := map[string][]byte{
		"empty": {}, "unknown": []byte("RIFFnot an mp3 or flac"), "no-mpeg": payloadID3(4, 0, nil), "no-flac": flac[:42],
		"single-mpeg-frame": mp3[:417], "mp3-truncated": mp3[:len(mp3)-1], "flac-truncated": flac[:len(flac)-1],
		"mp3-trailing": append(bytes.Clone(mp3), 0), "flac-trailing": append(bytes.Clone(flac), 0),
		"ape-tail": append(bytes.Clone(mp3), []byte("APETAGEX000000000000000000000000")...),
		"id3v22":   append(payloadID3(2, 0, nil), mp3...), "id3-unsync": append(payloadID3(3, 128, nil), mp3...),
		"id3-extended": append(payloadID3(4, 64, nil), mp3...), "id3-experimental": append(payloadID3(4, 32, nil), mp3...),
		"id3-reserved": append(payloadID3(4, 1, nil), mp3...), "id3-footer-v23": append(payloadID3(3, 16, nil), mp3...),
		"stacked-id3": append(payloadID3(4, 0, nil), append(payloadID3(4, 0, nil), mp3...)...),
	}
	mutate := func(name string, base []byte, off int, value byte) {
		b := bytes.Clone(base)
		b[off] = value
		cases[name] = b
	}
	id3 := append(payloadID3(4, 0, nil), mp3...)
	mutate("id3-nonsynchsafe", id3, 6, 128)
	mutate("id3-oversize", id3, 6, 127)
	mutate("id3-revision", id3, 4, 1)
	footer := append(payloadID3(4, 16, nil), mp3...)
	mutate("id3-footer-mismatch", footer, 13, 3)
	mutate("mpeg-reserved-version", mp3, 1, 0xeb)
	mutate("mpeg-reserved-layer", mp3, 1, 0xf9)
	mutate("mpeg-layer2", mp3, 1, 0xfd)
	mutate("mpeg-free-format", mp3, 2, 0)
	mutate("mpeg-reserved-rate", mp3, 2, 0x9c)
	mutate("mpeg-invalid-bitrate", mp3, 2, 0xf0)
	mutate("mpeg-invalid-emphasis", mp3, 3, 2)
	mutate("mpeg-discontinuous", mp3, 417+2, 0x94)
	mutate("mpeg-frame-sync", mp3, 417, 0)
	mutate("flac-block-overrun", flac, 7, 255)
	mutate("flac-streaminfo-not-first", flac, 4, 0x81)
	mutate("flac-streaminfo-wrong-size", flac, 7, 33)
	mutate("flac-unknown-block", flac, 4, 0xff)
	mutate("flac-no-last-block", flac, 4, 0)
	mutate("flac-invalid-blocksize", flac, 8, 0xff)
	mutate("flac-zero-rate", flac, 18, 0)
	mutate("flac-zero-total", flac, 25, 0)
	mutate("flac-header-crc", flac, 48, 0)
	mutate("flac-frame-crc", flac, len(flac)-1, 0)
	mutate("flac-invalid-subframe", flac, 49, 0x80)
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			if err := payloadCompare(b, b); err == nil {
				t.Fatal("invalid/unsupported input compared equal")
			}
		})
	}
	// Every truncation is rejected, including cuts precisely at metadata/frame boundaries.
	for name, b := range map[string][]byte{"mp3": mp3, "flac": flac} {
		for n := 0; n < len(b); n++ {
			if err := payloadCompare(b[:n], b[:n]); err == nil {
				t.Fatalf("%s truncation at %d accepted", name, n)
			}
		}
	}
}

type payloadGuardReader struct {
	data     []byte
	cancelAt int
	cancel   context.CancelFunc
	calls    int
	maxRead  int
	fail     bool
}

func (r *payloadGuardReader) ReadAt(p []byte, off int64) (int, error) {
	r.calls++
	if off < 0 || off > int64(len(r.data)) || int64(len(p)) > int64(len(r.data))-off {
		return 0, fmt.Errorf("outside fixture")
	}
	r.maxRead = max(r.maxRead, len(p))
	if r.fail {
		return 0, io.ErrUnexpectedEOF
	}
	if r.cancel != nil && r.calls == r.cancelAt {
		r.cancel()
	}
	return bytes.NewReader(r.data).ReadAt(p, off)
}
func TestPayloadBoundsAndCancellation(t *testing.T) {
	b := payloadMP3()
	r := &payloadGuardReader{data: b}
	for _, size := range []int64{-1, 0} {
		if err := CompareAudioPayload(context.Background(), r, size, r, size); !errors.Is(err, ErrUnsupportedPayload) {
			t.Fatalf("size %d: %v", size, err)
		}
	}
	if r.calls != 0 {
		t.Fatal("invalid size read source")
	}
	if err := CompareAudioPayload(context.Background(), nil, 1, r, 1); !errors.Is(err, ErrInvalidPayload) {
		t.Fatal(err)
	}
	if err := CompareAudioPayload(context.Background(), r, int64(len(b)+1), r, int64(len(b)+1)); err == nil {
		t.Fatal("declared size larger than backing source accepted")
	}
	r.fail = true
	if err := CompareAudioPayload(context.Background(), r, int64(len(b)), r, int64(len(b))); err == nil {
		t.Fatal("read failure accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.calls = 0
	if err := CompareAudioPayload(ctx, r, int64(len(b)), r, int64(len(b))); !errors.Is(err, context.Canceled) || r.calls != 0 {
		t.Fatalf("cancel before IO: %v", err)
	}
	for _, data := range [][]byte{payloadMP3(), payloadFLAC()} {
		measured := &payloadGuardReader{data: data}
		if err := CompareAudioPayload(context.Background(), measured, int64(len(data)), bytes.NewReader(data), int64(len(data))); err != nil {
			t.Fatal(err)
		}
		// Cancel at every read boundary, including metadata, frame parsing and hashing.
		for at := 1; at <= measured.calls; at++ {
			ctx, cancel := context.WithCancel(context.Background())
			r := &payloadGuardReader{data: data, cancel: cancel, cancelAt: at}
			err := CompareAudioPayload(ctx, r, int64(len(data)), bytes.NewReader(data), int64(len(data)))
			cancel()
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel at read %d: %v", at, err)
			}
		}
	}
	b = bytes.Repeat(payloadMP3(), 100)
	r = &payloadGuardReader{data: b}
	if err := CompareAudioPayload(context.Background(), r, int64(len(b)), r, int64(len(b))); err != nil {
		t.Fatal(err)
	}
	if r.maxRead != 32*1024 {
		t.Fatal("unbounded read")
	}
}

func TestPayloadEditedWorkingCopy(t *testing.T) {
	t.Setenv("METADATA_FIXTURE_DIR", "")
	for _, tc := range []struct {
		format, version string
		v1              bool
	}{{"mp3", "3", false}, {"mp3", "4", false}, {"mp3", "3", true}, {"flac", "", false}} {
		t.Run(fmt.Sprintf("%s%s-v1-%v", tc.format, tc.version, tc.v1), func(t *testing.T) {
			path := fixture(t, tc.format, tc.version)
			before := mustRead(t, path)
			if tc.v1 {
				n, err := syncSafe(before[6:10])
				if err != nil {
					t.Fatal(err)
				}
				v1 := make([]byte, 128)
				copy(v1, "TAGlegacy title")
				before = append(bytes.Clone(before[10+n:]), v1...)
				if err := os.WriteFile(path, before, 0600); err != nil {
					t.Fatal(err)
				}
			}
			oracle := packetHash(t, path)
			if err := payloadCompare(before, before); err != nil {
				t.Fatalf("generated fixture rejected: %v", err)
			}
			work := filepath.Join(filepath.Dir(path), "payload-working."+tc.format)
			if err := os.WriteFile(work, before, 0600); err != nil {
				t.Fatal(err)
			}
			title := "独立音频负载校验"
			artists := []string{"甲", "乙", "AC/DC"}
			pictures := []Picture{{"image/png", 3, "front", cover(t)}, {"image/png", 4, "back", cover(t)}}
			edit(t, work, Patch{Title: &title, Artists: &artists, Pictures: &pictures})
			after := mustRead(t, work)
			if err := payloadCompare(before, after); err != nil {
				t.Fatal(err)
			}
			got := readInfo(t, work, false)
			if got.Title != title || !reflect.DeepEqual(got.Artists, artists) || !reflect.DeepEqual(got.Pictures, pictures) {
				t.Fatal("edit did not round trip requested metadata")
			}
			if !bytes.Equal(oracle, packetHash(t, work)) {
				t.Fatal("independent ffprobe packets changed")
			}
			span, err := inspectPayload(payloadSource{context.Background(), bytes.NewReader(after), int64(len(after))})
			if err != nil {
				t.Fatal(err)
			}
			for _, offset := range []int64{span.start, span.start + 40, (span.start + span.end) / 2, span.end - 1} {
				changed := bytes.Clone(after)
				changed[offset] ^= 1
				if err := payloadCompare(before, changed); err == nil {
					t.Fatalf("audio mutation at %d accepted", offset)
				}
			}
			other := payloadEncode(t, tc.format, "sine=frequency=880:sample_rate=44100:duration=0.25", nil)
			if bytes.Equal(oracle, packetHash(t, other)) {
				t.Fatal("different-frequency oracle unexpectedly equal")
			}
			if err := payloadCompare(after, mustRead(t, other)); err == nil {
				t.Fatal("different encoded audio accepted")
			}
			if err := payloadCompare(after, after[:len(after)-1]); err == nil {
				t.Fatal("truncated edited copy accepted")
			}
			if !bytes.Equal(before, mustRead(t, path)) {
				t.Fatal("original generated fixture changed")
			}
		})
	}
}

func payloadEncode(t *testing.T, format, source string, options []string) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg missing: generated format coverage is NOT verified")
	}
	path := filepath.Join(t.TempDir(), "generated."+format)
	args := []string{"-v", "error", "-f", "lavfi", "-i", source, "-map_metadata", "-1"}
	args = append(args, options...)
	args = append(args, path)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("generate %s: %v: %s", format, err, out)
	}
	return path
}
func TestPayloadGeneratedEncodingVariants(t *testing.T) {
	for _, tc := range []struct {
		name, format, source string
		options              []string
	}{
		{"mpeg1-stereo-vbr", "mp3", "sine=frequency=330:sample_rate=48000:duration=0.5", []string{"-ac", "2", "-c:a", "libmp3lame", "-q:a", "3"}},
		{"mpeg2-mono", "mp3", "sine=frequency=330:sample_rate=22050:duration=0.5", []string{"-c:a", "libmp3lame", "-b:a", "64k"}},
		{"mpeg25-mono", "mp3", "sine=frequency=330:sample_rate=11025:duration=0.5", []string{"-c:a", "libmp3lame", "-b:a", "32k"}},
		{"flac-stereo24-lpc", "flac", "sine=frequency=330:sample_rate=48000:duration=0.5", []string{"-ac", "2", "-c:a", "flac", "-sample_fmt", "s32", "-compression_level", "12"}},
		{"flac-noise-verbatim", "flac", "anoisesrc=color=white:sample_rate=44100:duration=0.25:seed=123", []string{"-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "0"}},
		{"flac-constant", "flac", "anullsrc=r=44100:cl=stereo:d=0.25", []string{"-c:a", "flac"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := payloadEncode(t, tc.format, tc.source, tc.options)
			b := mustRead(t, path)
			packetHash(t, path)
			if err := payloadCompare(b, b); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPayloadMPEGSideAndXing(t *testing.T) {
	good := payloadMP3()
	copy(good[36:], "Xing")
	binary.BigEndian.PutUint32(good[40:44], 3)
	binary.BigEndian.PutUint32(good[44:48], 1)
	binary.BigEndian.PutUint32(good[48:52], uint32(len(good)))
	copy(good[52:], "LAME")
	if err := payloadCompare(good, good); err != nil {
		t.Fatal(err)
	}
	changed := bytes.Clone(good)
	changed[52] ^= 1
	if !errors.Is(payloadCompare(good, changed), ErrAudioPayloadChanged) {
		t.Fatal("LAME ancillary byte change was not retained in payload")
	}
	cases := map[string][]byte{}
	mutate := func(name string, off int, value byte) { b := bytes.Clone(good); b[off] = value; cases[name] = b }
	mutate("crc-protected", 1, 0xfa)
	mutate("reservoir-before-start", 4, 1)
	// First stereo granule/channel starts at bit 20 of side information.
	mutate("part-length-exceeds-main-data", 6, 15)
	mutate("big-values-out-of-range", 8, 0xff)
	mutate("zero-xing-frames", 47, 0)
	mutate("xing-frame-count-mismatch", 47, 2)
	mutate("xing-byte-count-mismatch", 51, 0)
	mutate("unknown-xing-flags", 40, 1)
	vbri := bytes.Clone(good)
	copy(vbri[36:], "VBRI")
	cases["vbri"] = vbri
	// A legal 72-byte MPEG-2.5 frame is too small for all Xing optional fields.
	short := make([]byte, 144)
	copy(short, []byte{0xff, 0xe3, 0x18, 0xc0})
	copy(short[72:], short[:4])
	copy(short[13:], "Xing")
	short[20] = 15
	cases["xing-fields-outside-frame"] = short
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			if err := payloadCompare(b, b); err == nil {
				t.Fatal("invalid side info/VBR layout accepted")
			}
		})
	}
	if err := payloadCompare(good, good[:417]); err == nil {
		t.Fatal("Xing frame-boundary truncation accepted")
	}
	if !errors.Is(payloadCompare(payloadMP3(), bytes.Repeat(payloadMP3(), 2)), ErrAudioPayloadChanged) {
		t.Fatal("whole-frame truncation/insertion not compared")
	}
}

func TestPayloadFLACStreamInfoAndStructure(t *testing.T) {
	good := payloadFLAC()
	changed := bytes.Clone(good)
	changed[26] ^= 1
	if !errors.Is(payloadCompare(good, changed), ErrAudioPayloadChanged) {
		t.Fatal("STREAMINFO MD5 change ignored")
	}
	if !errors.Is(payloadCompare(good, payloadMP3()), ErrAudioPayloadChanged) {
		t.Fatal("container change ignored")
	}
	// Recalculate both CRCs after header mutations so CRC failures cannot mask
	// invalid frame numbering/codes/STREAMINFO disagreement.
	for _, tc := range []struct {
		name  string
		off   int
		value byte
	}{
		{"frame-number", 46, 1}, {"reserved-sync", 43, 0xfa}, {"block-code", 44, 0x09},
		{"reserved-rate", 44, 0x6f}, {"wrong-channels", 45, 0x18}, {"reserved-depth", 45, 0x06},
		{"wrong-depth", 45, 0x02}, {"block-exceeds-total", 47, 16},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := bytes.Clone(good)
			b[tc.off] = tc.value
			b[48] = byte(payloadCRC(b[42:48], 8, 7))
			crc := payloadCRC(b[42:len(b)-2], 16, 0x8005)
			binary.BigEndian.PutUint16(b[len(b)-2:], uint16(crc))
			if err := payloadCompare(b, b); err == nil {
				t.Fatal("malformed FLAC with correct CRCs accepted")
			}
		})
	}
	for _, tc := range []struct {
		name  string
		block []byte
	}{
		{"short-application", []byte{0x82, 0, 0, 0}}, {"bad-seektable-size", []byte{0x83, 0, 0, 1, 0}},
		{"short-comment", []byte{0x84, 0, 0, 0}}, {"short-cuesheet", []byte{0x85, 0, 0, 0}},
		{"short-picture", []byte{0x86, 0, 0, 0}}, {"duplicate-streaminfo", append([]byte{0x80, 0, 0, 34}, good[8:42]...)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := bytes.Clone(good[:42])
			b[4] = 0
			b = append(b, tc.block...)
			b = append(b, good[42:]...)
			if err := payloadCompare(b, b); err == nil {
				t.Fatal("invalid metadata layout accepted")
			}
		})
	}
}
