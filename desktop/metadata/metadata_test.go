package metadata

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tommyo123/mtag"
	"github.com/tommyo123/mtag/id3v2"
)

func fixture(t *testing.T, format, version string) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required only to generate test audio")
	}
	dir := t.TempDir()
	if base := os.Getenv("METADATA_FIXTURE_DIR"); base != "" {
		var err error
		dir, err = os.MkdirTemp(base, strings.ReplaceAll(t.Name(), "/", "-")+"-")
		if err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, "generated."+format)
	args := []string{"-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.25", "-map_metadata", "-1"}
	switch format {
	case "mp3":
		args = append(args, "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", version)
	case "flac":
		args = append(args, "-c:a", "flac")
	case "m4a":
		args = append(args, "-c:a", "aac")
	case "ogg":
		args = append(args, "-ac", "2", "-c:a", "vorbis", "-strict", "experimental")
	}
	args = append(args, path)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("generate fixture: %v: %s", err, out)
	}
	t.Logf("self-generated fixture: %s", path)
	return path
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func readInfo(t *testing.T, path string, scan bool) Info {
	t.Helper()
	b := mustRead(t, path)
	var info Info
	var err error
	if scan {
		info, err = ParseScan(bytes.NewReader(b), int64(len(b)))
	} else {
		info, err = Parse(bytes.NewReader(b), int64(len(b)))
	}
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func edit(t *testing.T, path string, patch Patch) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := EditWorkingCopy(context.Background(), f, stat.Size(), patch); err != nil {
		t.Fatal(err)
	}
}

// Independent ffprobe hashes demuxed audio packets, excluding all metadata.
func packetHash(t *testing.T, path string) []byte {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=data_hash", "-show_data_hash", "sha256", "-of", "json", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ffprobe: %v: %s", err, out)
	}
	var result struct {
		Packets []struct {
			Hash string `json:"data_hash"`
		} `json:"packets"`
	}
	if err := json.Unmarshal(out, &result); err != nil || len(result.Packets) == 0 {
		t.Fatalf("packet hashes missing: %v: %s", err, out)
	}
	for _, p := range result.Packets {
		if !strings.HasPrefix(p.Hash, "SHA256:") {
			t.Fatalf("invalid packet hash: %q", p.Hash)
		}
	}
	return out
}

func cover(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func seedUnknown(t *testing.T, path, format string) []byte {
	t.Helper()
	f, err := mtag.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	f.SetCustomValues("HEMUSIC_UNKNOWN", "keep one", "keep two")
	if format == "mp3" {
		f.ID3v2().Set(&id3v2.RawFrame{FrameID: "XHEM", Data: []byte{0, 1, 255, 42, 19}})
	}
	if err := f.Save(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if format != "flac" {
		return nil
	}
	b := mustRead(t, path)
	end := 8 + int(b[5])<<16 + int(b[6])<<8 + int(b[7])
	block := append([]byte{2, 0, 0, 19}, []byte("HEMuunknown-payload")...)
	updated := append(append(append([]byte(nil), b[:end]...), block...), b[end:]...)
	if err := os.WriteFile(path, updated, 0o600); err != nil {
		t.Fatal(err)
	}
	return block
}

func TestMetadataRoundTrip(t *testing.T) {
	for _, tc := range []struct{ format, version string }{{"mp3", "3"}, {"mp3", "4"}, {"flac", ""}} {
		t.Run(tc.format+tc.version, func(t *testing.T) {
			original := fixture(t, tc.format, tc.version)
			unknownBlock := seedUnknown(t, original, tc.format)
			before := mustRead(t, original)
			packets := packetHash(t, original)
			work := filepath.Join(filepath.Dir(original), "working."+tc.format)
			if err := os.WriteFile(work, before, 0o600); err != nil {
				t.Fatal(err)
			}
			title, album, comment, lyrics := "中文标题", "专辑", "别名备注", "[00:01.00]第一行\n[00:02.00]second line"
			artists := []string{"歌手甲", "AC/DC", "artist; literal"}
			albumArtists := []string{"专辑艺术家", "ensemble"}
			pictures := []Picture{{"image/png", 3, "front", cover(t)}, {"image/png", 4, "back", cover(t)}}
			edit(t, work, Patch{&title, &artists, &album, &albumArtists, &comment, &lyrics, &pictures})
			got := readInfo(t, work, false)
			assertMetadataRoundTripInfo(t, got, tc.format, Info{Title: title, Album: album, Comment: comment, Lyrics: lyrics, Artists: artists, AlbumArtists: albumArtists, Pictures: pictures})
			assertMetadataScan(t, work, artists)
			// Editing a scalar after a scan must preserve all loaded pictures and arrays.
			title = strings.Repeat("增长标题", 1000)
			edit(t, work, Patch{Title: &title})
			got = readInfo(t, work, false)
			if got.Title != title || !reflect.DeepEqual(got.Pictures, pictures) || !reflect.DeepEqual(got.Artists, artists) || !reflect.DeepEqual(got.AlbumArtists, albumArtists) {
				t.Fatal("scalar edit lost untouched metadata")
			}
			assertUnknownMetadata(t, work, tc.format, unknownBlock)
			if !bytes.Equal(packets, packetHash(t, work)) || !bytes.Equal(before, mustRead(t, original)) {
				t.Fatal("audio packet payload or original fixture changed")
			}
			empty, emptyArtists, emptyPictures := "", []string{}, []Picture{}
			edit(t, work, Patch{Title: &empty, Artists: &emptyArtists, AlbumArtists: &emptyArtists, Lyrics: &empty, Pictures: &emptyPictures})
			cleared := readInfo(t, work, false)
			if cleared.Title != "" || len(cleared.Artists) != 0 || len(cleared.AlbumArtists) != 0 || cleared.Lyrics != "" || len(cleared.Pictures) != 0 || cleared.Album != album || cleared.Comment != comment {
				t.Fatalf("clear/preserve mismatch: %+v", cleared)
			}
			if !bytes.Equal(packets, packetHash(t, work)) {
				t.Fatal("clear changed audio packets")
			}
		})
	}
}

func assertMetadataRoundTripInfo(t *testing.T, got Info, format string, want Info) {
	t.Helper()
	if got.Title != want.Title || got.Album != want.Album || got.Comment != want.Comment || got.Lyrics != want.Lyrics || !reflect.DeepEqual(got.Artists, want.Artists) || !reflect.DeepEqual(got.AlbumArtists, want.AlbumArtists) || !reflect.DeepEqual(got.Pictures, want.Pictures) {
		t.Fatalf("field round trip mismatch: %+v", got)
	}
	if got.DurationSeconds < 0.2 || got.DurationSeconds > 0.4 || got.SampleRateHz != 44100 || got.Channels != 1 || got.BitrateKbps <= 0 || got.BitrateKbps > 1000 {
		t.Fatalf("audio property units: %+v", got)
	}
	if format == "mp3" && (got.BitrateKbps < 120 || got.BitrateKbps > 150 || got.BitsPerSample != 0) {
		t.Fatalf("MP3 properties: %+v", got)
	}
	if format == "flac" && got.BitsPerSample != 16 {
		t.Fatalf("FLAC bit depth: %+v", got)
	}
}

func assertMetadataScan(t *testing.T, work string, artists []string) {
	t.Helper()
	prior := sha256.Sum256(mustRead(t, work))
	scan := readInfo(t, work, true)
	if scan.PicturesLoaded || len(scan.Pictures) != 0 || !reflect.DeepEqual(scan.Artists, artists) || sha256.Sum256(mustRead(t, work)) != prior {
		t.Fatalf("scan must be read-only and omit pictures: %+v", scan)
	}
}

func assertUnknownMetadata(t *testing.T, work, format string, unknownBlock []byte) {
	t.Helper()
	f, err := mtag.Open(work, mtag.WithReadOnly())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.CustomValues("HEMUSIC_UNKNOWN"), []string{"keep one", "keep two"}) {
		t.Fatal("unknown text field lost")
	}
	if format == "mp3" {
		raw, ok := f.ID3v2().Find("XHEM").(*id3v2.RawFrame)
		if !ok || !bytes.Equal(raw.Data, []byte{0, 1, 255, 42, 19}) {
			t.Fatal("unknown ID3 frame lost")
		}
	}
	f.Close()
	if len(unknownBlock) > 0 && !bytes.Contains(mustRead(t, work), unknownBlock) {
		t.Fatal("unknown FLAC APPLICATION block lost")
	}
}

func TestMetadataUnsupportedAndCancelled(t *testing.T) {
	for _, format := range []string{"m4a", "ogg"} {
		t.Run(format, func(t *testing.T) {
			path := fixture(t, format, "")
			b := mustRead(t, path)
			if _, err := Parse(bytes.NewReader(b), int64(len(b))); err != nil {
				t.Fatalf("expected unsupported: %v", err)
			}
			f, err := os.OpenFile(path, os.O_RDWR, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if err := EditWorkingCopy(context.Background(), f, int64(len(b)), Patch{}); err != nil {
				t.Fatalf("expected unsupported edit: %v", err)
			}
			after := mustRead(t, path)
			if err := CompareAudioPayload(context.Background(), bytes.NewReader(b), int64(len(b)), bytes.NewReader(after), int64(len(after))); err != nil {
				t.Fatalf("tag save changed audio: %v", err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := EditWorkingCopy(ctx, nil, 0, Patch{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation before IO: %v", err)
	}
	if _, err := Parse(bytes.NewReader([]byte("not audio")), 9); err == nil {
		t.Fatal("malformed input accepted")
	}
}
