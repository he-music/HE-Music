package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/transform"
	"github.com/he-music/HE-Music/desktop/internal/httpclient"
)

func gatewayAudioURL(origin, target, encoded, format string) string {
	return origin + "/__audio?" + url.Values{"url": {target}, "audio_params": {encoded}, "format": {format}}.Encode()
}

func streamTestParams(t *testing.T) string {
	t.Helper()
	encoded, err := transform.Encode(transform.Parameters{Version: 1, Kind: transform.Subtract, Key: []byte("0123456789ABCDEF0123456789ABCDEF")})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func encryptStreamAudio(plain []byte, encoded string) []byte {
	params, err := transform.Parse(encoded)
	if err != nil {
		panic(err)
	}
	data := bytes.Clone(plain)
	for i := range data {
		data[i] += params.Key[i%len(params.Key)]
	}
	return data
}

func TestGatewayAudioStreamRangesAndIgnoredRanges(t *testing.T) {
	plain := []byte("RIFF synthetic audio spanning several encryption key cycles 0123456789")
	key := streamTestParams(t)
	encrypted := encryptStreamAudio(plain, key)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != httpclient.DefaultUserAgent {
			t.Errorf("unexpected default User-Agent %q", r.UserAgent())
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" || r.Header.Get("Referer") != "" {
			t.Error("browser credentials leaked to audio CDN")
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/audio?signature=a%2Bb", http.StatusTemporaryRedirect)
			return
		}
		if r.URL.Path == "/ignore" {
			w.Header().Set("Content-Length", fmt.Sprint(len(encrypted)))
			if r.Method != http.MethodHead {
				_, _ = w.Write(encrypted)
			}
			return
		}
		if r.URL.Path == "/different" {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 10-19/%d", len(encrypted)))
			w.Header().Set("Content-Length", "10")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(encrypted[10:20])
			return
		}
		http.ServeContent(w, r, "audio.wav", time.Time{}, bytes.NewReader(encrypted))
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	for _, test := range []struct {
		path, byteRange, want string
		status                int
	}{
		{"/audio", "", string(plain), http.StatusOK},
		{"/audio", "bytes=31-40", string(plain[31:41]), http.StatusPartialContent},
		{"/audio", "bytes=-5", string(plain[len(plain)-5:]), http.StatusPartialContent},
		{"/redirect", "bytes=5-12", string(plain[5:13]), http.StatusPartialContent},
		{"/different", "bytes=5-12", string(plain[10:20]), http.StatusPartialContent},
		{"/ignore", "bytes=5-12", string(plain), http.StatusOK},
	} {
		t.Run(test.path+test.byteRange, func(t *testing.T) {
			response, data := gatewayRequest(t, http.MethodGet, gatewayAudioURL(origin, upstream.URL+test.path, key, "wav"), "", map[string]string{
				"Range": test.byteRange, "Authorization": "Bearer private", "Cookie": "private=1", "Origin": "mygo://app", "Referer": "https://private.example/",
			})
			if response.StatusCode != test.status || data != test.want || response.Header.Get("Content-Type") != "audio/wav" {
				t.Fatalf("status=%d data=%q headers=%v", response.StatusCode, data, response.Header)
			}
			if response.Header.Get("Access-Control-Allow-Origin") != "mygo://app" || response.Header.Get("Cache-Control") != "private, no-store" {
				t.Fatal("missing local audio response headers")
			}
		})
	}
	response, data := gatewayRequest(t, http.MethodHead, gatewayAudioURL(origin, upstream.URL+"/audio", key, "wav"), "", nil)
	if response.StatusCode != http.StatusOK || data != "" || response.Header.Get("Content-Length") != fmt.Sprint(len(plain)) {
		t.Fatalf("invalid HEAD: %d %q", response.StatusCode, data)
	}
}

func TestGatewayAudioRejectsFailuresWithoutLeakingKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "upstream private", http.StatusForbidden) }))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	for _, encoded := range []string{"", "invalid-secret", streamTestParams(t)} {
		response, data := gatewayRequest(t, http.MethodGet, gatewayAudioURL(origin, upstream.URL, encoded, "wav"), "", nil)
		status := http.StatusBadRequest
		if encoded == streamTestParams(t) {
			status = http.StatusBadGateway
		}
		if response.StatusCode != status || strings.Contains(data, "secret") || strings.Contains(data, "private") {
			t.Fatalf("unexpected response: %d %s", response.StatusCode, data)
		}
	}
	response, _ := gatewayRequest(t, http.MethodGet, origin+"/__audio?platform=legacy&key=secret&url="+url.QueryEscape(upstream.URL), "", nil)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatal("accepted legacy parameters")
	}
}

func TestGatewayAudioRejectsInvalidResponseRanges(t *testing.T) {
	for _, contentRange := range []string{"", "bytes -1-9/10", "bytes 0-9/9", "bytes 0-9/10junk", "bytes 9-0/10", "bytes 0-9/10,20-30/40"} {
		response := &http.Response{StatusCode: http.StatusPartialContent, ContentLength: 10, Header: http.Header{"Content-Range": {contentRange}}}
		if _, err := transform.AudioOffset(response); err == nil {
			t.Fatalf("accepted malformed range %q", contentRange)
		}
	}
}

func sampleGatewayFixture(t *testing.T) ([]byte, string) {
	t.Helper()
	box := func(kind string, payload ...[]byte) []byte {
		data := bytes.Join(payload, nil)
		result := make([]byte, len(data)+8)
		binary.BigEndian.PutUint32(result, uint32(len(result)))
		copy(result[4:8], kind)
		copy(result[8:], data)
		return result
	}
	key := []byte("0123456789abcdef")
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	iv := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	var counter [16]byte
	copy(counter[:], iv)
	sample := []byte("synthetic MP4 audio payload")
	cipher.NewCTR(block, counter[:]).XORKeyStream(sample, sample)
	stsz := make([]byte, 12)
	binary.BigEndian.PutUint32(stsz[4:8], uint32(len(sample)))
	binary.BigEndian.PutUint32(stsz[8:12], 1)
	senc := make([]byte, 16)
	binary.BigEndian.PutUint32(senc[4:8], 1)
	copy(senc[8:], iv)
	file := box("ftyp", []byte("M4A "))
	file = append(file, box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsz", stsz), box("senc", senc))))))...)
	file = append(file, box("mdat", sample)...)
	encoded, err := transform.Encode(transform.Parameters{Version: 1, Kind: transform.SampleCTR, Key: key, UserAgent: "test-media-client"})
	if err != nil {
		t.Fatal(err)
	}
	return file, encoded
}

func TestGatewayAudioSodaDownloadsOnceThenServesPlaintextRanges(t *testing.T) {
	file, auth := sampleGatewayFixture(t)
	params, err := transform.Parse(auth)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := transform.DecryptSamples(file, params, false)
	if err != nil {
		t.Fatal(err)
	}
	var downloads atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/audio", http.StatusFound)
			return
		}
		if r.Header.Get("Range") != "" || r.UserAgent() != "test-media-client" {
			t.Error("invalid soda upstream request")
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(file)))
		if r.Method != http.MethodHead {
			downloads.Add(1)
			_, _ = w.Write(file)
		}
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	local := gatewayAudioURL(origin, upstream.URL+"/redirect", auth, "m4a")
	response, data := gatewayRequest(t, http.MethodHead, local, "", nil)
	if response.StatusCode != http.StatusOK || data != "" || downloads.Load() != 0 {
		t.Fatal("HEAD downloaded soda samples")
	}
	for _, interval := range [][2]int{{10, 20}, {30, 40}} {
		response, data = gatewayRequest(t, http.MethodGet, local, "", map[string]string{"Range": fmt.Sprintf("bytes=%d-%d", interval[0], interval[1]-1)})
		if response.StatusCode != http.StatusPartialContent || data != string(expected[interval[0]:interval[1]]) {
			t.Fatal("invalid soda plaintext range")
		}
	}
	if downloads.Load() != 1 {
		t.Fatalf("soda downloaded %d times", downloads.Load())
	}
}

func TestGatewayAudioNativeDownloadSavesDecryptedPayload(t *testing.T) {
	plain := downloadMP3()
	key := streamTestParams(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(encryptStreamAudio(plain, key))
	}))
	defer upstream.Close()
	_, origin := gatewayTestServer(t, GatewayAPIConfig{})
	a, ctx, epoch, coordinator, token, dir := downloadFixture(t)
	req := downloadReq(t, token, "decrypted.mp3")
	req.URL = gatewayAudioURL(origin, upstream.URL, key, "mp3")
	job := downloadStart(t, a, ctx, epoch, coordinator, req)
	downloadWait(t, job)
	if job.state.Code != "ok" || !job.state.Committed {
		t.Fatalf("download failed: %+v", job.state)
	}
	data, err := os.ReadFile(filepath.Join(dir, "decrypted.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, plain) {
		t.Fatal("download did not save plaintext audio")
	}
	assertDownloadClean(t, dir)
}
