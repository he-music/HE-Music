package metadata

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func dffTestChunk(kind string, data []byte) []byte {
	out := make([]byte, 12+len(data)+(len(data)&1))
	copy(out, kind)
	binary.BigEndian.PutUint64(out[4:12], uint64(len(data)))
	copy(out[12:], data)
	return out
}

// Structural fixtures cover DSDIFF framing, not DST decoder compatibility.
func dffTestFixture(dst bool) []byte {
	compression := "DSD "
	media := bytes.Repeat([]byte{0x69, 0x96}, 32)
	if dst {
		compression = "DST "
		media = dffTestChunk("FRTE", []byte{0, 0, 0, 2, 0, 75})
		media = append(media, dffTestChunk("DSTF", []byte{1, 2, 3})...)
		media = append(media, dffTestChunk("DSTC", []byte{0, 0, 0, 1})...)
		media = append(media, dffTestChunk("DSTF", []byte{4, 5, 6, 7})...)
	}
	props := append([]byte("SND "), dffTestChunk("FS  ", []byte{0, 43, 17, 0})...)
	props = append(props, dffTestChunk("CHNL", append([]byte{0, 2}, []byte("SLFTSRGT")...))...)
	props = append(props, dffTestChunk("CMPR", append([]byte(compression), 0))...)
	body := append([]byte("DSD "), dffTestChunk("FVER", []byte{1, 5, 0, 0})...)
	body = append(body, dffTestChunk("PROP", props)...)
	body = append(body, dffTestChunk(compression, media)...)
	body = append(body, dffTestChunk("COMT", []byte{0, 0})...)
	return dffTestChunk("FRM8", body)
}

func TestDFFMetadataRoundTrip(t *testing.T) {
	for _, dst := range []bool{false, true} {
		t.Run(map[bool]string{false: "dsd", true: "dst"}[dst], func(t *testing.T) {
			before := dffTestFixture(dst)
			path := filepath.Join(t.TempDir(), "synthetic.dff")
			if err := os.WriteFile(path, before, 0o600); err != nil {
				t.Fatal(err)
			}
			title, album, lyrics := "DFF 标题", "专辑", "[00:00.00]歌词"
			artists := []string{"歌手一", "歌手二"}
			pictures := []Picture{{MIME: "image/png", Type: 3, Data: cover(t)}}
			for _, nextTitle := range []string{title, strings.Repeat(title, 2000), "短标题"} {
				edit(t, path, Patch{Title: &nextTitle, Album: &album, Artists: &artists, Lyrics: &lyrics, Pictures: &pictures})
				assertDFFReadback(t, path, nextTitle, album, lyrics, artists, pictures, dst)
				after := mustRead(t, path)
				if err := CompareAudioPayload(t.Context(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); err != nil {
					t.Fatal(err)
				}
			}
			empty, noPictures := "", []Picture{}
			edit(t, path, Patch{Lyrics: &empty, Pictures: &noPictures})
			if info := readInfo(t, path, false); info.Lyrics != "" || len(info.Pictures) != 0 {
				t.Fatal("clear failed")
			}
		})
	}
}

func assertDFFReadback(t *testing.T, path, title, album, lyrics string, artists []string, pictures []Picture, dst bool) {
	t.Helper()
	info := readInfo(t, path, false)
	if info.Title != title || info.Album != album || info.Lyrics != lyrics || !reflect.DeepEqual(info.Artists, artists) || len(info.Pictures) != 1 || !bytes.Equal(info.Pictures[0].Data, pictures[0].Data) {
		t.Fatalf("roundtrip: %+v", info)
	}
	if info.Codec != map[bool]string{false: "dsd", true: "dst"}[dst] || info.DurationSeconds <= 0 || info.SampleRateHz != 2822400 || info.Channels != 2 || info.BitsPerSample != 1 {
		t.Fatalf("audio properties: %+v", info)
	}
	if dst && info.DurationSeconds != 2.0/75 {
		t.Fatalf("DST duration: %v", info.DurationSeconds)
	}
	scan := readInfo(t, path, true)
	if scan.Title != title || scan.PicturesLoaded || len(scan.Pictures) != 0 {
		t.Fatalf("scan: %+v", scan)
	}
}

func TestDFFRejectsChangedAudioAndInvalidLayouts(t *testing.T) {
	before := dffTestFixture(true)
	compare := func(after []byte) error {
		return CompareAudioPayload(t.Context(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after)))
	}
	for _, kind := range []string{"DSTF", "FS  ", "CHNL", "COMT"} {
		t.Run("changed_"+kind, func(t *testing.T) {
			after := bytes.Clone(before)
			at := bytes.Index(after, []byte(kind)) + 12
			// Keep the structural header valid while changing protected content.
			if kind == "CHNL" {
				at += 2
			}
			after[at] ^= 1
			if err := compare(after); !errors.Is(err, ErrAudioPayloadChanged) {
				t.Fatalf("changed %s accepted: %v", kind, err)
			}
		})
	}
	for _, name := range []string{"extent", "chunk_overflow", "frame_count", "zero_rate", "duplicate_media", "missing_pad", "wrong_form", "trailing_byte"} {
		t.Run(name, func(t *testing.T) {
			after := bytes.Clone(before)
			switch name {
			case "extent":
				after[11]--
			case "chunk_overflow":
				binary.BigEndian.PutUint64(after[20:28], ^uint64(0))
			case "frame_count":
				after[bytes.Index(after, []byte("FRTE"))+15]++
			case "zero_rate":
				at := bytes.Index(after, []byte("FRTE")) + 16
				clear(after[at : at+2])
			case "duplicate_media":
				after = append(after, dffTestChunk("DST ", []byte{1, 2})...)
			case "missing_pad":
				at := bytes.Index(after, []byte("DSTF")) + 15
				after = append(after[:at], after[at+1:]...)
			case "wrong_form":
				copy(after[12:16], "WAVE")
			case "trailing_byte":
				after = append(after, 0)
			}
			if name != "extent" {
				binary.BigEndian.PutUint64(after[4:12], uint64(len(after)-12))
			}
			if err := CompareAudioPayload(t.Context(), bytes.NewReader(after), int64(len(after)), bytes.NewReader(after), int64(len(after))); err == nil {
				t.Fatal("invalid DFF accepted")
			}
		})
	}
	for _, n := range []int{0, 4, 15, len(before) - 1} {
		if err := compare(before[:n]); err == nil {
			t.Fatalf("truncated DFF accepted: %d", n)
		}
	}
}

func TestDFFRejectsRelocatedIndexedAudio(t *testing.T) {
	before := dffTestFixture(true)
	before = append(before, dffTestChunk("DSTI", make([]byte, 24))...)
	binary.BigEndian.PutUint64(before[4:12], uint64(len(before)-12))
	after := append(bytes.Clone(before[:16]), dffTestChunk("ID3 ", []byte{1, 2})...)
	after = append(after, before[16:]...)
	binary.BigEndian.PutUint64(after[4:12], uint64(len(after)-12))
	if err := CompareAudioPayload(t.Context(), bytes.NewReader(before), int64(len(before)), bytes.NewReader(after), int64(len(after))); !errors.Is(err, ErrAudioPayloadChanged) {
		t.Fatalf("relocated indexed DST accepted: %v", err)
	}
}
