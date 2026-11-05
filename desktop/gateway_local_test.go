package main

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestLocalGatewaySidecarsAndAbsolutePaths(t *testing.T) {
	_, base := gatewayTestServer(t, GatewayAPIConfig{})
	for _, directory := range []string{"one", "two"} {
		name := filepath.Join(t.TempDir(), directory, "歌曲 #100% &.mp3")
		requireTestNoError(t, os.MkdirAll(filepath.Dir(name), 0o700))
		requireTestNoError(t, os.WriteFile(name, []byte("malformed tags"), 0o600))
		stem := strings.TrimSuffix(name, ".mp3")
		lyrics := "[00:01.00]" + directory
		requireTestNoError(t, os.WriteFile(stem+".lrc", []byte(lyrics), 0o600))
		var picture bytes.Buffer
		// A valid wide PNG must be displayed even though the old display path rejected >4096px.
		requireTestNoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 5000, 1))))
		requireTestNoError(t, os.WriteFile(stem+".png", picture.Bytes(), 0o600))
		query := url.Values{"path": {name}}.Encode()
		response, body := gatewayRequest(t, "GET", base+"/__local/lyrics?"+query, "", map[string]string{"Origin": "mygo://localhost"})
		if response.StatusCode != http.StatusOK || body != lyrics || response.Header.Get("Access-Control-Allow-Origin") != "mygo://localhost" {
			t.Fatalf("lyrics response: %d %q", response.StatusCode, body)
		}
		response, body = gatewayRequest(t, "GET", base+"/__local/artwork?"+query, "", nil)
		if response.StatusCode != http.StatusOK || !bytes.Equal([]byte(body), picture.Bytes()) || response.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("artwork response: %d %s", response.StatusCode, response.Header.Get("Content-Type"))
		}
		response, body = gatewayRequest(t, "HEAD", base+"/__local/artwork?"+query, "", nil)
		if response.StatusCode != http.StatusOK || body != "" || response.Header.Get("Content-Length") != strconv.Itoa(picture.Len()) {
			t.Fatal("HEAD response mismatch")
		}
		response, _ = gatewayRequest(t, "POST", base+"/__local/lyrics?"+query, "", nil)
		if response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatal("unexpected method accepted")
		}
	}
}

func TestLocalGatewayEmbeddedArtworkIgnoresIncorrectMIMEAndUsesSidecarLyrics(t *testing.T) {
	directory := t.TempDir()
	name := filepath.Join(directory, "song.mp3")
	requireTestNoError(t, os.WriteFile(name, downloadMP3(), 0o600))
	file, err := os.OpenFile(name, os.O_RDWR, 0)
	requireTestNoError(t, err)
	defer file.Close()
	stat, err := file.Stat()
	requireTestNoError(t, err)
	var picture bytes.Buffer
	requireTestNoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 1, 1))))
	pictures := []metadata.Picture{{MIME: "image/jpg", Type: 3, Data: picture.Bytes()}}
	lyrics := "[00:00.00]embedded"
	requireTestNoError(t, metadata.EditWorkingCopy(t.Context(), file, stat.Size(), metadata.Patch{Pictures: &pictures, Lyrics: &lyrics}))
	file.Close()
	_, base := gatewayTestServer(t, GatewayAPIConfig{})
	query := url.Values{"path": {name}}.Encode()
	response, body := gatewayRequest(t, "GET", base+"/__local/artwork?"+query, "", nil)
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "image/png" || !bytes.Equal([]byte(body), picture.Bytes()) {
		t.Fatal("embedded image was rejected by its declared MIME")
	}
	response, body = gatewayRequest(t, "GET", base+"/__local/lyrics?"+query, "", nil)
	if response.StatusCode != http.StatusOK || body != lyrics {
		t.Fatal("embedded lyrics missing")
	}
	requireTestNoError(t, os.WriteFile(filepath.Join(directory, "song.lrc"), []byte("[00:00.00]sidecar"), 0o600))
	_, body = gatewayRequest(t, "GET", base+"/__local/lyrics?"+query, "", nil)
	if body != "[00:00.00]sidecar" {
		t.Fatal("sidecar did not override embedded lyrics")
	}
}

func TestLocalGatewayBrowserImageFormats(t *testing.T) {
	for _, tc := range []struct {
		data []byte
		mime string
	}{
		{[]byte("GIF89a\x01\x00\x01\x00"), "image/gif"},
		{[]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp"},
	} {
		if got := localResourceImageMIME(tc.data); got != tc.mime {
			t.Fatalf("got %s, want %s", got, tc.mime)
		}
	}
}

func TestLocalScanReturnsAbsolutePaths(t *testing.T) {
	actor, ctx, epoch, token, directory := scanTestGrant(t)
	scanTestWrite(t, filepath.Join(directory, "song.mp3"), []byte("unreadable tags"))
	entries, _ := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != 1 || !filepath.IsAbs(entries[0].Path) || filepath.Base(entries[0].Path) != "song.mp3" {
		t.Fatalf("scan did not return absolute path: %+v", entries)
	}
}

func TestLocalGatewayAudioRanges(t *testing.T) {
	_, base := gatewayTestServer(t, GatewayAPIConfig{})
	for _, tc := range []struct {
		ext  string
		mime string
		data []byte
	}{
		{"mp3", "audio/mpeg", downloadMP3()},
		{"FLAC", "audio/flac", downloadFLAC()},
	} {
		t.Run(tc.ext, func(t *testing.T) {
			name := filepath.Join(t.TempDir(), "我怀念的 - 孙燕姿 #100% &."+tc.ext)
			requireTestNoError(t, os.WriteFile(name, tc.data, 0o600))
			resource := base + "/__local/audio?" + url.Values{"path": {name}}.Encode()
			response, body := gatewayRequest(t, "GET", resource, "", map[string]string{"Origin": "mygo://localhost"})
			if response.StatusCode != http.StatusOK || !bytes.Equal([]byte(body), tc.data) || response.Header.Get("Content-Type") != tc.mime || response.Header.Get("Access-Control-Allow-Origin") != "mygo://localhost" {
				t.Fatalf("GET: %d %v", response.StatusCode, response.Header)
			}
			response, body = gatewayRequest(t, "HEAD", resource, "", nil)
			if response.StatusCode != http.StatusOK || body != "" || response.Header.Get("Content-Length") != strconv.Itoa(len(tc.data)) || response.Header.Get("Accept-Ranges") != "bytes" {
				t.Fatal("HEAD metadata mismatch")
			}
			for _, part := range []struct {
				header     string
				start, end int
			}{
				{"bytes=0-3", 0, 4},
				{"bytes=4-", 4, len(tc.data)},
				{"bytes=-4", len(tc.data) - 4, len(tc.data)},
			} {
				response, body = gatewayRequest(t, "GET", resource, "", map[string]string{"Range": part.header})
				want := "bytes " + strconv.Itoa(part.start) + "-" + strconv.Itoa(part.end-1) + "/" + strconv.Itoa(len(tc.data))
				if response.StatusCode != http.StatusPartialContent || response.Header.Get("Content-Range") != want || !bytes.Equal([]byte(body), tc.data[part.start:part.end]) {
					t.Fatalf("Range %s: %d %v", part.header, response.StatusCode, response.Header)
				}
			}
			response, _ = gatewayRequest(t, "GET", resource, "", map[string]string{"Range": "bytes=999999-"})
			if response.StatusCode != http.StatusRequestedRangeNotSatisfiable || response.Header.Get("Content-Range") != "bytes */"+strconv.Itoa(len(tc.data)) {
				t.Fatal("invalid range did not return 416")
			}
		})
	}
}

func TestLocalGatewayAudioStreamsLargeFiles(t *testing.T) {
	_, base := gatewayTestServer(t, GatewayAPIConfig{})
	name := filepath.Join(t.TempDir(), "large.flac")
	file, err := os.Create(name)
	requireTestNoError(t, err)
	requireTestNoError(t, file.Truncate(3<<30))
	_, err = file.WriteAt([]byte("tail"), (3<<30)-4)
	requireTestNoError(t, err)
	requireTestNoError(t, file.Close())
	response, body := gatewayRequest(t, "GET", base+"/__local/audio?"+url.Values{"path": {name}}.Encode(), "", map[string]string{"Range": "bytes=-4"})
	if response.StatusCode != http.StatusPartialContent || body != "tail" {
		t.Fatalf("large audio range: %d %q", response.StatusCode, body)
	}
}
