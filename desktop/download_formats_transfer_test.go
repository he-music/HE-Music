package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func nativeEncodedFixture(t *testing.T, suffix string) []byte {
	t.Helper()
	if suffix == "ape" {
		// Structural MAC fixture: opaque synthetic frame data, not a valid encoded
		// Monkey's Audio recording or evidence of decoder compatibility.
		b := make([]byte, 52+24+4+64)
		copy(b, "MAC ")
		binary.LittleEndian.PutUint16(b[4:6], 3990)
		for _, v := range []struct {
			offset int
			value  uint32
		}{{8, 52}, {12, 24}, {16, 4}, {24, 64}, {56, 73728}, {60, 1024}, {64, 1}, {72, 44100}, {76, 80}} {
			binary.LittleEndian.PutUint32(b[v.offset:v.offset+4], v.value)
		}
		binary.LittleEndian.PutUint16(b[52:54], 2000)
		binary.LittleEndian.PutUint16(b[68:70], 16)
		binary.LittleEndian.PutUint16(b[70:72], 2)
		for i := 80; i < len(b); i++ {
			b[i] = byte(i)
		}
		return b
	}
	out := filepath.Join(t.TempDir(), "synthetic."+suffix)
	args := []string{"-v", "error", "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=44100:duration=0.25", "-map_metadata", "-1"}
	switch suffix {
	case "mp3":
		args = append(args, "-c:a", "libmp3lame")
	case "flac":
		args = append(args, "-c:a", "flac")
	case "wav":
		args = append(args, "-c:a", "pcm_s16le")
	case "aif", "aiff":
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
		t.Fatalf("unknown recipe: %s", suffix)
	}
	args = append(args, out)
	encoder, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required to encode synthetic transfer fixtures")
	}
	if output, err := exec.Command(encoder, args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg %s: %v: %s", suffix, err, output)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestNativeElevenFormatsFullTransfer(t *testing.T) {
	for _, suffix := range []string{"mp3", "flac", "wav", "aac", "webm", "m4a", "mp4", "ogg", "aiff", "aif", "ape"} {
		t.Run(suffix, func(t *testing.T) {
			data := nativeEncodedFixture(t, suffix)
			var jpg bytes.Buffer
			if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
				t.Fatal(err)
			}
			for _, edit := range []bool{false, true} {
				t.Run(map[bool]string{false: "preserve", true: "edit"}[edit], func(t *testing.T) {
					a, ctx, epoch, c, token, dir := downloadFixture(t)
					c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
						if r.URL.Host == "cover.invalid" {
							return &http.Response{StatusCode: 200, ContentLength: -1, Header: http.Header{"Content-Type": []string{"image/jpeg"}}, Body: io.NopCloser(bytes.NewReader(jpg.Bytes()))}, nil
						}
						return downloadResponse(data, int64(len(data))), nil
					})
					req := downloadReq(t, token, "song."+suffix)
					req.Options = &DownloadOptions{RelativeDirectory: "Artist/Album"}
					if edit {
						req.Options.WriteMetadata = true
						req.Options.WriteLyrics = true
						req.Options.WriteCover = true
						req.Options.SaveSidecars = true
						req.Options.Metadata = &DownloadMetadata{Title: "title", Album: "album", Artists: []string{"first", "second"}, Lyrics: "[00:00.00]lyrics", CoverURL: "https://cover.invalid/image"}
					}
					j := downloadStart(t, a, ctx, epoch, c, req)
					downloadWait(t, j)
					st, err := c.access(a.state, ctx, epoch, req.OperationID, false)
					if err != nil {
						t.Fatal(err)
					}
					target := filepath.Join(dir, "Artist/Album", req.Filename)
					if !st.Committed {
						if !edit {
							t.Fatalf("preserve rejected: %+v", st)
						}
						if st.Code != "unsupported" && st.Code != "payload_rejected" {
							t.Fatalf("unexpected edit failure: %+v", st)
						}
						if _, err := os.Stat(target); !os.IsNotExist(err) {
							t.Fatalf("rejected edit published: %v", err)
						}
						if suffix != "webm" && suffix != "m4a" && suffix != "mp4" && suffix != "ape" {
							t.Fatalf("previously writable fixture rejected: %+v", st)
						}
						assertRejectedNativeRewrite(t, a, c, j, req, target)
						t.Logf("explicit unsupported layout: %s %s; existing target preserved", suffix, st.Code)
						return
					}
					if st.Code != "ok" || st.Ref == nil {
						t.Fatalf("%+v", st)
					}
					after, err := os.ReadFile(target)
					if err != nil {
						t.Fatal(err)
					}
					assertNativeTransferPayload(t, j, data, after, jpg.Bytes(), edit)
				})
			}
		})
	}
}

func assertNativeTransferPayload(t *testing.T, j *downloadJob, data, after, jpg []byte, edit bool) {
	t.Helper()
	if err := metadata.CompareAudioPayload(j.lease.owner, bytes.NewReader(data), int64(len(data)), bytes.NewReader(after), int64(len(after))); err != nil {
		t.Fatal(err)
	}
	if !edit {
		if !bytes.Equal(data, after) {
			t.Fatal("unrequested edit")
		}
		return
	}
	info, err := metadata.Parse(bytes.NewReader(after), int64(len(after)))
	if err != nil {
		t.Fatal(err)
	}
	if info.Title != "title" || info.Album != "album" || info.Lyrics != "[00:00.00]lyrics" || !reflect.DeepEqual(info.Artists, []string{"first", "second"}) || len(info.Pictures) != 1 || !bytes.Equal(info.Pictures[0].Data, jpg) {
		t.Fatalf("readback mismatch %+v", info)
	}
}

func assertRejectedNativeRewrite(t *testing.T, a *fileTestActor, c *downloadCoordinator, previous *downloadJob, req DownloadRequest, target string) {
	t.Helper()
	ctx, epoch := previous.lease.owner, previous.lease.epoch
	if err := os.WriteFile(target, []byte("existing target"), 0o600); err != nil {
		t.Fatal(err)
	}
	retry := downloadReq(t, req.GrantToken, req.Filename)
	retry.Options = req.Options
	job := downloadStart(t, a, ctx, epoch, c, retry)
	downloadWait(t, job)
	rejected, _ := c.access(a.state, ctx, epoch, retry.OperationID, false)
	if rejected.Committed || rejected.Ref != nil || rejected.Code != "unsupported" {
		t.Fatalf("rejected rewrite: %+v", rejected)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "existing target" {
		t.Fatalf("existing changed: %q %v", got, err)
	}
}
