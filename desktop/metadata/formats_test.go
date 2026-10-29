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
			if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); err != nil {
				t.Fatal(err)
			}
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
			if err := CompareFormatAudioPayload(context.Background(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(final), int64(len(final))); err != nil {
				t.Fatal(err)
			}
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
	if err := os.WriteFile(path, before, 0600); err != nil {
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
