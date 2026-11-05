package metadata

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func formatsFixture(t *testing.T, suffix string) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required for local synthetic fixtures")
	}
	path := filepath.Join(t.TempDir(), "synthetic."+suffix)
	args := []string{"-v", "error", "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=44100:duration=0.25", "-map_metadata", "-1"}
	switch suffix {
	case "wav":
		args = append(args, "-c:a", "pcm_s16le")
	case "aiff", "aif":
		args = append(args, "-c:a", "pcm_s16be", "-f", "aiff")
	case "aac":
		args = append(args, "-c:a", "aac", "-f", "adts")
	case "m4a", "mp4":
		args = append(args, "-c:a", "aac", "-movflags", "+faststart")
	case "ogg":
		args = append(args, "-ac", "2", "-c:a", "vorbis", "-strict", "experimental")
	case "webm":
		args = append(args, "-c:a", "libopus")
	default:
		t.Fatalf("no synth recipe for %s", suffix)
	}
	args = append(args, path)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("synthesize %s: %v: %s", suffix, err, out)
	}
	return path
}

func TestFormatsMetadataRoundTrip(t *testing.T) {
	for _, suffix := range []string{"wav", "aac", "webm", "m4a", "mp4", "ogg", "aiff", "aif"} {
		t.Run(suffix, func(t *testing.T) {
			path := formatsFixture(t, suffix)
			before := mustRead(t, path)
			originalHash := formatsPacketHash(t, path)
			if _, err := ParseScan(bytes.NewReader(before), int64(len(before))); err != nil {
				t.Fatal(err)
			}
			title, album, comment, lyrics := "测试 title", "测试 album", "测试 comment", "[00:00.00]测试 lyrics"
			artists, albumArtists := []string{"测试 artist"}, []string{"测试 album artist"}
			image := cover(t)
			pictures := []Picture{{MIME: "image/png", Type: 3, Description: "front", Data: image}}
			patch := Patch{Title: &title, Album: &album, Artists: &artists, AlbumArtists: &albumArtists, Comment: &comment, Lyrics: &lyrics, Pictures: &pictures}
			edit(t, path, patch)
			after := mustRead(t, path)
			if bytes.Equal(before, after) {
				t.Fatal("metadata save did not change file")
			}
			info := readInfo(t, path, false)
			if info.Title != title || info.Album != album || info.Comment != comment || info.Lyrics != lyrics || !reflect.DeepEqual(info.Artists, artists) || !reflect.DeepEqual(info.AlbumArtists, albumArtists) {
				t.Fatalf("roundtrip mismatch: %+v", info)
			}
			if len(info.Pictures) != 1 || !bytes.Equal(info.Pictures[0].Data, image) {
				t.Fatalf("picture mismatch: %+v", info.Pictures)
			}
			scan := readInfo(t, path, true)
			if scan.PicturesLoaded || len(scan.Pictures) > 0 || scan.Title != title {
				t.Fatalf("scan mismatch: %+v", scan)
			}
			if !bytes.Equal(originalHash, formatsPacketHash(t, path)) {
				t.Fatal("encoded packet hashes changed")
			}
			requireMetadataNoError(t, CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))))
			// Grow existing tags, then clear fields and pictures; both save paths must
			// preserve the same encoded packets and remain independently parseable.
			title = strings.Repeat("长 title ", 2000) + "end"
			edit(t, path, Patch{Title: &title})
			if got := readInfo(t, path, false).Title; got != title {
				t.Fatalf("grown title length %d", len(got))
			}
			empty := ""
			noPictures := []Picture{}
			edit(t, path, Patch{Lyrics: &empty, Pictures: &noPictures})
			cleared := readInfo(t, path, false)
			if cleared.Lyrics != "" || len(cleared.Pictures) != 0 {
				t.Fatal("clear failed")
			}
			final := mustRead(t, path)
			if !bytes.Equal(originalHash, formatsPacketHash(t, path)) {
				t.Fatal("encoded packets changed after growth/clear")
			}
			requireMetadataNoError(t, CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(final), int64(len(final))))
		})
	}
}

// ffmpeg has no APE encoder here. This fixture exercises real MAC/APE layout
// and metadata rewriting, with an opaque synthetic frame body. It is explicitly
// not evidence of a valid Monkey's Audio bitstream or decoder compatibility.
func formatsMACFixture() []byte {
	b := make([]byte, 52+24+4+64)
	copy(b, "MAC ")
	binary.LittleEndian.PutUint16(b[4:6], 3990)
	binary.LittleEndian.PutUint32(b[8:12], 52)
	binary.LittleEndian.PutUint32(b[12:16], 24)
	binary.LittleEndian.PutUint32(b[16:20], 4)
	binary.LittleEndian.PutUint32(b[24:28], 64)
	binary.LittleEndian.PutUint16(b[52:54], 2000)
	binary.LittleEndian.PutUint32(b[56:60], 73728)
	binary.LittleEndian.PutUint32(b[60:64], 1024)
	binary.LittleEndian.PutUint32(b[64:68], 1)
	binary.LittleEndian.PutUint16(b[68:70], 16)
	binary.LittleEndian.PutUint16(b[70:72], 2)
	binary.LittleEndian.PutUint32(b[72:76], 44100)
	binary.LittleEndian.PutUint32(b[76:80], 80)
	for i := 80; i < len(b); i++ {
		b[i] = byte(i)
	}
	return b
}

func TestFormatsMACMetadataStructureRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synthetic.ape")
	before := formatsMACFixture()
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	title, album, lyrics := "APE title", "APE album", "APE lyrics"
	artists := []string{"APE artist"}
	pictures := []Picture{{MIME: "image/png", Type: 3, Data: cover(t)}}
	edit(t, path, Patch{Title: &title, Album: &album, Artists: &artists, Lyrics: &lyrics, Pictures: &pictures})
	info := readInfo(t, path, false)
	if info.Container != "mac" || info.Title != title || info.Album != album || info.Lyrics != lyrics || !reflect.DeepEqual(info.Artists, artists) || len(info.Pictures) != 1 || !bytes.Equal(info.Pictures[0].Data, pictures[0].Data) {
		t.Fatalf("MAC roundtrip: %+v", info)
	}
	after := mustRead(t, path)
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); err != nil {
		t.Fatal(err)
	}
	after[81] ^= 1
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); !errors.Is(err, ErrAudioPayloadChanged) {
		t.Fatalf("corrupt MAC accepted: %v", err)
	}
}

type formatsSparseReader struct {
	head    []byte
	size    int64
	maxRead int
	calls   int
}

func (r *formatsSparseReader) ReadAt(p []byte, off int64) (int, error) {
	r.calls++
	r.maxRead = max(r.maxRead, len(p))
	if off < 0 || off >= r.size {
		return 0, io.EOF
	}
	n := int(min(int64(len(p)), r.size-off))
	clear(p[:n])
	if off < int64(len(r.head)) {
		copy(p[:n], r.head[off:])
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func TestFormatsSparseWAVNoSizeCap(t *testing.T) {
	const size int64 = 33 << 20
	head := make([]byte, 44)
	copy(head, "RIFF")
	binary.LittleEndian.PutUint32(head[4:8], uint32(size-8))
	copy(head[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(head[16:20], 16)
	binary.LittleEndian.PutUint16(head[20:22], 1)
	binary.LittleEndian.PutUint16(head[22:24], 1)
	binary.LittleEndian.PutUint32(head[24:28], 44100)
	binary.LittleEndian.PutUint32(head[28:32], 88200)
	binary.LittleEndian.PutUint16(head[32:34], 2)
	binary.LittleEndian.PutUint16(head[34:36], 16)
	copy(head[36:40], "data")
	binary.LittleEndian.PutUint32(head[40:44], uint32(size-44))
	r := &formatsSparseReader{head: head, size: size}
	if info, err := ParseScan(r, size); err != nil || info.Container != "wav" {
		t.Fatalf("large scan: %+v, %v", info, err)
	}
	if err := CompareFormatAudioPayload(context.Background(), r, size, r, size); err != nil {
		t.Fatal(err)
	}
	if r.maxRead > 32768 {
		t.Fatalf("unbounded read: %d", r.maxRead)
	}
	t.Logf("size=%d max read=%d calls=%d; body generated on demand", size, r.maxRead, r.calls)
}

func TestFormatsMalformedAndCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CompareFormatAudioPayload(ctx, nil, 0, nil, 0); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, suffix := range []string{"wav", "aac", "webm", "m4a", "ogg", "aiff"} {
		t.Run(suffix, func(t *testing.T) {
			data := mustRead(t, formatsFixture(t, suffix))
			for _, n := range []int{0, 3, 11, len(data) - 1} {
				truncated := data[:n]
				if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(truncated), int64(n), bytes.NewReader(truncated), int64(n)); err == nil {
					t.Fatalf("accepted truncated %s (%d)", suffix, n)
				}
			}
		})
	}
}

func formatsPacketHash(t *testing.T, path string) []byte {
	t.Helper()
	var diagnostics bytes.Buffer
	cmd := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=data_hash", "-show_data_hash", "sha256", "-of", "json", path)
	cmd.Stderr = &diagnostics
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ffprobe: %v: %s", err, diagnostics.String())
	}
	var result struct {
		Packets []struct {
			Hash string `json:"data_hash"`
		} `json:"packets"`
	}
	if err := json.Unmarshal(out, &result); err != nil || len(result.Packets) == 0 {
		t.Fatalf("packet hashes missing: %v: %s", err, out)
	}
	var hashes []string
	for _, p := range result.Packets {
		if p.Hash == "" {
			t.Fatal("empty packet hash")
		}
		hashes = append(hashes, p.Hash)
	}
	return []byte(strings.Join(hashes, "\n"))
}

func TestFormatsPayloadChangesRejected(t *testing.T) {
	for _, suffix := range []string{"wav", "aac", "webm", "m4a", "ogg", "aiff"} {
		t.Run(suffix, func(t *testing.T) {
			original := mustRead(t, formatsFixture(t, suffix))
			changed := append([]byte(nil), original...)
			at := -1
			switch suffix {
			case "wav":
				at = bytes.Index(changed, []byte("data")) + 8
			case "aiff":
				at = bytes.Index(changed, []byte("SSND")) + 16
			case "m4a":
				at = bytes.Index(changed, []byte("mdat")) + 4
			case "webm":
				start := bytes.Index(changed, []byte{0x1f, 0x43, 0xb6, 0x75})
				if start >= 0 {
					at = start + 20
				}
			default:
				at = len(changed) - 1
			}
			if at < 0 || at >= len(changed) {
				t.Fatal("fixture payload not found")
			}
			changed[at] ^= 1
			if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(original), int64(len(original)), bytes.NewReader(changed), int64(len(changed))); err == nil {
				t.Fatal("changed payload accepted")
			}
		})
	}
}

func TestFormatsMP4OffsetChangeRejected(t *testing.T) {
	original := mustRead(t, formatsFixture(t, "m4a"))
	changed := append([]byte(nil), original...)
	at := bytes.Index(changed, []byte("stco"))
	if at < 0 {
		t.Fatal("stco not present")
	}
	changed[at+15] ^= 1
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(original), int64(len(original)), bytes.NewReader(changed), int64(len(changed))); err == nil {
		t.Fatal("changed sample offset accepted")
	}
}

func TestFormatsRF64RoundTrip(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required for local synthetic fixtures")
	}
	path := filepath.Join(t.TempDir(), "synthetic.wav")
	out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.1", "-c:a", "pcm_s16le", "-rf64", "always", path).CombinedOutput()
	if err != nil {
		t.Fatalf("RF64 synth: %v: %s", err, out)
	}
	before := mustRead(t, path)
	originalHash := formatsPacketHash(t, path)
	title := "RF64 title"
	edit(t, path, Patch{Title: &title})
	if got := readInfo(t, path, false); got.Title != title {
		t.Fatalf("RF64: %+v", got)
	}
	after := mustRead(t, path)
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(originalHash, formatsPacketHash(t, path)) {
		t.Fatal("RF64 encoded packets changed")
	}
}

func TestFormatsOggOpusRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required for local synthetic fixtures")
	}
	path := filepath.Join(t.TempDir(), "synthetic.ogg")
	out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "libopus", path).CombinedOutput()
	if err != nil {
		t.Fatalf("Opus synth: %v: %s", err, out)
	}
	before := mustRead(t, path)
	originalHash := formatsPacketHash(t, path)
	title, lyrics := "Opus title", "Opus lyrics"
	images := []Picture{{MIME: "image/png", Type: 3, Data: cover(t)}}
	edit(t, path, Patch{Title: &title, Lyrics: &lyrics, Pictures: &images})
	got := readInfo(t, path, false)
	if got.Title != title || got.Lyrics != lyrics || len(got.Pictures) != 1 || !bytes.Equal(got.Pictures[0].Data, images[0].Data) {
		t.Fatalf("Opus: %+v", got)
	}
	after := mustRead(t, path)
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(originalHash, formatsPacketHash(t, path)) {
		t.Fatal("Opus encoded packets changed")
	}
}

// Change a real encoded audio page's timestamp, then restore its valid CRC.
func TestFormatsOggNonEOSGranuleRejected(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required for local synthetic fixtures")
	}
	for _, codec := range []string{"libopus", "vorbis"} {
		t.Run(codec, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "timing.ogg")
			if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=3", "-ac", "2", "-c:a", codec, "-strict", "experimental", path).CombinedOutput(); err != nil {
				t.Fatalf("synth: %v: %s", err, out)
			}
			original := mustRead(t, path)
			changed := append([]byte(nil), original...)
			found := false
			for off := 0; off < len(changed); {
				count := int(changed[off+26])
				end := off + 27 + count
				for _, n := range changed[off+27 : end] {
					end += int(n)
				}
				granule := binary.LittleEndian.Uint64(changed[off+6 : off+14])
				if changed[off+5]&4 == 0 && granule > 0 && granule != ^uint64(0) {
					binary.LittleEndian.PutUint64(changed[off+6:off+14], granule+1)
					clear(changed[off+22 : off+26])
					binary.LittleEndian.PutUint32(changed[off+22:off+26], formatOggCRC(0, changed[off:end]))
					found = true
					break
				}
				off = end
			}
			if !found {
				t.Fatal("no non-EOS audio page")
			}
			if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(changed), int64(len(changed)), bytes.NewReader(changed), int64(len(changed))); err != nil {
				t.Fatalf("modified page must still be structurally valid: %v", err)
			}
			if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(original), int64(len(original)), bytes.NewReader(changed), int64(len(changed))); !errors.Is(err, ErrAudioPayloadChanged) {
				t.Fatalf("changed granule accepted: %v", err)
			}
		})
	}
}

type formatsCountReader struct {
	*bytes.Reader
	calls int
	bytes int
}

func (r *formatsCountReader) ReadAt(p []byte, off int64) (int, error) {
	r.calls++
	r.bytes += len(p)
	return r.Reader.ReadAt(p, off)
}

func formatsAtomBytes(kind string, body []byte) []byte {
	b := make([]byte, 8+len(body))
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	copy(b[4:], kind)
	copy(b[8:], body)
	return b
}

func TestFormatsMP4ChunkOffsetReadWork(t *testing.T) {
	const count = 512
	b := formatsAtomBytes("ftyp", []byte("M4A \x00\x00\x00\x00"))
	for range count {
		b = append(b, formatsAtomBytes("free", nil)...)
	}
	mediaStart := len(b) + 8
	b = append(b, formatsAtomBytes("mdat", bytes.Repeat([]byte{7}, count))...)
	offsets := make([]byte, 8+4*count)
	binary.BigEndian.PutUint32(offsets[4:], count)
	for i := range count {
		binary.BigEndian.PutUint32(offsets[8+4*i:], uint32(mediaStart+i))
	}
	stbl := append(formatsAtomBytes("stsd", []byte{0, 0, 0, 0}), formatsAtomBytes("stco", offsets)...)
	b = append(b, formatsAtomBytes("moov", formatsAtomBytes("stbl", stbl))...)
	r := &formatsCountReader{Reader: bytes.NewReader(b)}
	if err := CompareFormatAudioPayload(context.Background(), r, int64(len(b)), r, int64(len(b))); err != nil {
		t.Fatal(err)
	}
	t.Logf("free=%d chunks=%d calls=%d bytes=%d", count, count, r.calls, r.bytes)
	if r.calls > 16*count || r.bytes > 128*count {
		t.Fatalf("multiplicative header reads: calls=%d bytes=%d", r.calls, r.bytes)
	}
}

// Sparse declared metadata bodies must never be read by validator selection.
type formatsProbeReader struct {
	head   []byte
	at     int64
	tail   []byte
	calls  int
	cancel context.CancelFunc
}

func (r *formatsProbeReader) ReadAt(p []byte, off int64) (int, error) {
	r.calls++
	if r.cancel != nil {
		r.cancel()
	}
	if off == 0 && len(p) <= len(r.head) {
		return copy(p, r.head), nil
	}
	if off == r.at && len(p) <= len(r.tail) {
		return copy(p, r.tail), nil
	}
	return 0, errors.New("probe attempted to read metadata body")
}

func TestFormatsAdditionalPayloadFormatProbe(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		head []byte
		want bool
	}{
		{"wave", []byte("RIFF\x00\x00\x00\x00WAVE"), true},
		{"rf64", []byte("RF64\x00\x00\x00\x00WAVE"), true},
		{"aiff", []byte("FORM\x00\x00\x00\x00AIFF"), true},
		{"mp4", []byte("\x00\x00\x00\x10ftypM4A "), true},
		{"ogg", []byte("OggS\x00\x00\x00\x00\x00\x00\x00\x00"), true},
		{"mac", []byte("MAC \x00\x00\x00\x00\x00\x00\x00\x00"), true},
		{"webm", []byte{0x1a, 0x45, 0xdf, 0xa3}, true},
		{"adts", []byte{0xff, 0xf1}, true},
		{"mp3", []byte{0xff, 0xfb}, false},
		{"flac", []byte("fLaC"), false},
		{"unknown", []byte("unknown"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &formatsProbeReader{head: tc.head}
			got, err := AdditionalPayloadFormat(ctx, r, int64(len(tc.head)))
			if err != nil || got != tc.want || r.calls != 1 {
				t.Fatalf("got=%v err=%v reads=%d", got, err, r.calls)
			}
		})
	}
	for _, footer := range []bool{false, true} {
		const tagSize = 128 << 20
		head := []byte{'I', 'D', '3', 4, 0, 0, 64, 0, 0, 0, 0, 0}
		at := int64(10 + tagSize)
		if footer {
			head[5] = 0x10
			at += 10
		}
		for _, tail := range [][]byte{{0xff, 0xf1}, {0xff, 0xfb}} {
			r := &formatsProbeReader{head: head, at: at, tail: tail}
			got, err := AdditionalPayloadFormat(ctx, r, at+1024)
			if err != nil || got != (tail[1] == 0xf1) || r.calls != 2 {
				t.Fatalf("ID3 footer=%v: got=%v err=%v reads=%d", footer, got, err, r.calls)
			}
		}
	}
	// A huge ilst/text body is irrelevant: selecting MP4 reads only its header.
	r := &formatsProbeReader{head: []byte("\x00\x00\x00\x10ftypM4A ")}
	if got, err := AdditionalPayloadFormat(ctx, r, 1<<40); err != nil || !got || r.calls != 1 {
		t.Fatalf("large MP4: %v %v reads=%d", got, err, r.calls)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := AdditionalPayloadFormat(cancelled, r, 1<<40); !errors.Is(err, context.Canceled) || r.calls != 1 {
		t.Fatalf("pre-cancel: %v reads=%d", err, r.calls)
	}
	mid, cancelMid := context.WithCancel(ctx)
	r = &formatsProbeReader{head: []byte("OggS"), cancel: cancelMid}
	if _, err := AdditionalPayloadFormat(mid, r, 4); !errors.Is(err, context.Canceled) || r.calls != 1 {
		t.Fatalf("read cancellation: %v reads=%d", err, r.calls)
	}
	for _, b := range [][]byte{[]byte("ID3"), {'I', 'D', '3', 4, 0, 0, 127, 127, 127, 127}, {'I', 'D', '3', 4, 0, 0, 128, 0, 0, 0}} {
		if _, err := AdditionalPayloadFormat(ctx, bytes.NewReader(b), int64(len(b))); err == nil {
			t.Fatalf("malformed ID3 accepted: %x", b)
		}
	}
}

func TestFormatsMP4MediaIndexBoundaries(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []string{"stco", "co64"} {
		makeMP4 := func(gap int, delta int64) []byte {
			b := formatsAtomBytes("ftyp", []byte("M4A \x00\x00\x00\x00"))
			first := len(b) + 8
			b = append(b, formatsAtomBytes("mdat", []byte{1, 2, 3})...)
			b = append(b, formatsAtomBytes("free", make([]byte, gap))...)
			second := len(b) + 8
			b = append(b, formatsAtomBytes("mdat", []byte{4, 5, 6})...)
			width := 4
			if kind == "co64" {
				width = 8
			}
			offsets := make([]byte, 8+3*width)
			binary.BigEndian.PutUint32(offsets[4:], 3)
			// Unsorted entries require searching by address, not a forward-only cursor.
			for i, off := range []int64{int64(second) + delta, int64(first), int64(second + 2)} {
				if width == 8 {
					binary.BigEndian.PutUint64(offsets[8+i*width:], uint64(off))
				} else {
					binary.BigEndian.PutUint32(offsets[8+i*width:], uint32(off))
				}
			}
			stbl := append(formatsAtomBytes("stsd", []byte{0, 0, 0, 0}), formatsAtomBytes(kind, offsets)...)
			return append(b, formatsAtomBytes("moov", formatsAtomBytes("stbl", stbl))...)
		}
		left, right := makeMP4(0, 0), makeMP4(512, 0)
		if err := CompareFormatAudioPayload(ctx, bytes.NewReader(left), int64(len(left)), bytes.NewReader(right), int64(len(right))); err != nil {
			t.Fatalf("%s relocated mdat: %v", kind, err)
		}
		for _, delta := range []int64{-1, 3, 1 << 32} {
			bad := makeMP4(512, delta)
			// stco cannot express the 64-bit overflow case.
			if kind == "stco" && delta == 1<<32 {
				continue
			}
			if err := CompareFormatAudioPayload(ctx, bytes.NewReader(bad), int64(len(bad)), bytes.NewReader(bad), int64(len(bad))); !errors.Is(err, ErrInvalidPayload) {
				t.Fatalf("%s delta=%d: %v", kind, delta, err)
			}
		}
	}
}

func TestFormatsDifferentContainersRejected(t *testing.T) {
	wav := mustRead(t, formatsFixture(t, "wav"))
	aiff := mustRead(t, formatsFixture(t, "aiff"))
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(wav), int64(len(wav)), bytes.NewReader(aiff), int64(len(aiff))); !errors.Is(err, ErrAudioPayloadChanged) {
		t.Fatal(err)
	}
}

// Structural pages isolate comment pagination from the SDK writer. Audio bytes
// are opaque here; real encoded Opus/Vorbis coverage is in the tests above.
func TestFormatsOggCommentRepagination(t *testing.T) {
	page := func(seq uint32, flags byte, granule uint64, laces, body []byte) []byte {
		b := make([]byte, 27+len(laces)+len(body))
		copy(b, "OggS")
		b[5] = flags
		binary.LittleEndian.PutUint64(b[6:], granule)
		binary.LittleEndian.PutUint32(b[14:], 123)
		binary.LittleEndian.PutUint32(b[18:], seq)
		b[26] = byte(len(laces))
		copy(b[27:], laces)
		copy(b[27+len(laces):], body)
		binary.LittleEndian.PutUint32(b[22:], formatOggCRC(0, b))
		return b
	}
	makeOgg := func(long bool, granule uint64) []byte {
		head := []byte("OpusHeadabcdefghijk")
		b := page(0, 2, 0, []byte{byte(len(head))}, head)
		seq := uint32(1)
		if long {
			comment := append([]byte("OpusTags"), bytes.Repeat([]byte{'x'}, 292)...)
			b = append(b, page(seq, 0, ^uint64(0), []byte{255}, comment[:255])...)
			seq++
			b = append(b, page(seq, 1, 0, []byte{45}, comment[255:])...)
		} else {
			b = append(b, page(seq, 0, 0, []byte{8}, []byte("OpusTags"))...)
		}
		seq++
		b = append(b, page(seq, 0, granule, []byte{3}, []byte{1, 2, 3})...)
		seq++
		return append(b, page(seq, 4, 1920, []byte{3}, []byte{4, 5, 6})...)
	}
	left, right := makeOgg(false, 960), makeOgg(true, 960)
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(left), int64(len(left)), bytes.NewReader(right), int64(len(right))); err != nil {
		t.Fatal(err)
	}
	changed := makeOgg(true, 961)
	if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(left), int64(len(left)), bytes.NewReader(changed), int64(len(changed))); !errors.Is(err, ErrAudioPayloadChanged) {
		t.Fatal(err)
	}
}
