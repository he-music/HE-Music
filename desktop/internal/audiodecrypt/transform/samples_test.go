// 来源与同步说明见 ../README.md。
package transform

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func mp4TestBox(kind string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	result := make([]byte, 8+len(body))
	binary.BigEndian.PutUint32(result, uint32(len(result)))
	copy(result[4:8], kind)
	copy(result[8:], body)
	return result
}

func testPlayAuth(key []byte) string {
	encoded, err := Encode(Parameters{Version: Version, Kind: SampleCTR, Key: key})
	if err != nil {
		panic(err)
	}
	return encoded
}

func DecryptAudio(data []byte, encoded string) ([]byte, error) {
	p, err := Parse(encoded)
	if err != nil {
		return nil, err
	}
	return DecryptSamples(data, p, false)
}

func DecryptAudioInPlace(data []byte, encoded string) ([]byte, error) {
	p, err := Parse(encoded)
	if err != nil {
		return nil, err
	}
	return DecryptSamples(data, p, true)
}

func encryptedFixture(t *testing.T) ([]byte, []byte, string) {
	t.Helper()
	key := []byte("0123456789abcdef")
	plain := []byte("a complete synthetic audio sample")
	iv := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	fullIV := make([]byte, aes.BlockSize)
	copy(fullIV, iv)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	encrypted := make([]byte, len(plain))
	cipher.NewCTR(block, fullIV).XORKeyStream(encrypted, plain)
	stsz := make([]byte, 12)
	binary.BigEndian.PutUint32(stsz[4:8], uint32(len(plain)))
	binary.BigEndian.PutUint32(stsz[8:12], 1)
	senc := make([]byte, 16)
	binary.BigEndian.PutUint32(senc[4:8], 1)
	copy(senc[8:], iv)
	tenc := make([]byte, 8)
	tenc[7] = 8
	sinf := mp4TestBox("sinf", mp4TestBox("frma", []byte("mp4a")), mp4TestBox("schi", mp4TestBox("tenc", tenc)))
	stsd := mp4TestBox("stsd", make([]byte, 8), mp4TestBox("enca", make([]byte, 28), sinf))
	stbl := mp4TestBox("stbl", stsd, mp4TestBox("stsz", stsz), mp4TestBox("senc", senc))
	moov := mp4TestBox("moov", mp4TestBox("trak", mp4TestBox("mdia", mp4TestBox("minf", stbl))))
	file := bytes.Join([][]byte{mp4TestBox("ftyp", []byte("M4A ")), moov, mp4TestBox("mdat", encrypted)}, nil)
	return file, plain, testPlayAuth(key)
}

func TestDecryptAudioInPlaceMatchesCopyAndReusesBuffer(t *testing.T) {
	file, _, auth := encryptedFixture(t)
	expected, err := DecryptAudio(file, auth)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecryptAudioInPlace(file, auth)
	if err != nil {
		t.Fatal(err)
	}
	if &decoded[0] != &file[0] || !bytes.Equal(decoded, expected) {
		t.Fatal("in-place decryption must reuse input and match the copying API")
	}
}

func TestDecryptAudioInPlaceValidatesBeforeMutation(t *testing.T) {
	file, _, auth := encryptedFixture(t)
	stsz, err := findBoxDeep(file, "stsz", 0, len(file))
	if err != nil {
		t.Fatal(err)
	}
	binary.BigEndian.PutUint32(stsz.data[4:8], uint32(len(file)))
	original := bytes.Clone(file)
	if _, err := DecryptAudioInPlace(file, auth); err == nil {
		t.Fatal("accepted sample outside mdat")
	}
	if !bytes.Equal(file, original) {
		t.Fatal("invalid MP4 was modified")
	}
}

func TestDecryptSampleIVSizes(t *testing.T) {
	block, err := aes.NewCipher([]byte("0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{8, 16} {
		senc := make([]byte, 8+size)
		binary.BigEndian.PutUint32(senc[4:8], 1)
		for i := range size {
			senc[8+i] = byte(i + 1)
		}
		var counter [aes.BlockSize]byte
		copy(counter[:], senc[8:])
		plain := []byte("audio spanning multiple AES blocks")
		encrypted := make([]byte, len(plain))
		cipher.NewCTR(block, counter[:]).XORKeyStream(encrypted, plain)
		samples := parseSenc(senc, size)
		if len(samples) != 1 || samples[0].iv != counter {
			t.Fatalf("invalid %d-byte IV", size)
		}
		decryptSencSampleInto(block, encrypted, encrypted, &samples[0])
		if !bytes.Equal(encrypted, plain) {
			t.Fatalf("decryption differs with %d-byte IV", size)
		}
	}
}

func TestDecryptCompleteMP4(t *testing.T) {
	file, plain, auth := encryptedFixture(t)
	original := bytes.Clone(file)
	decoded, err := DecryptAudio(file, auth)
	if err != nil {
		t.Fatal(err)
	}
	mdat, err := findBox(decoded, "mdat", 0, len(decoded))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mdat.data, plain) {
		t.Fatalf("audio mismatch: %x", mdat.data)
	}
	if bytes.Contains(decoded, []byte("enca")) {
		t.Error("encrypted sample entry was not restored")
	}
	if !bytes.Equal(file, original) {
		t.Fatal("decoder mutated the caller's input")
	}
}

func TestServeAudioAppliesRangeAfterDecryption(t *testing.T) {
	file, _, auth := encryptedFixture(t)
	expected, err := DecryptAudio(file, auth)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			t.Error("partial ciphertext was requested")
		}
		_, _ = w.Write(file)
	}))
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "http://decrypt.example/", nil)
	req.Header.Set("Range", "bytes=10-19")
	w := httptest.NewRecorder()
	ServeAudio(w, req, upstream.Client(), upstream.URL, auth)
	if w.Code != http.StatusPartialContent {
		t.Fatalf("range status %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(w.Body.Bytes(), expected[10:20]) {
		t.Fatal("range did not apply to plaintext")
	}
	if w.Header().Get("Content-Range") == "" {
		t.Fatal("missing Content-Range")
	}
}

func TestServeAudioHeadAndErrors(t *testing.T) {
	file, _, auth := encryptedFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(file) }))
	defer upstream.Close()
	w := httptest.NewRecorder()
	ServeAudio(w, httptest.NewRequest(http.MethodHead, "http://decrypt.example/", nil), upstream.Client(), upstream.URL, auth)
	if w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get("Content-Length") == "" {
		t.Fatalf("invalid HEAD response: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	ServeAudio(w, httptest.NewRequest(http.MethodGet, "http://decrypt.example/", nil), upstream.Client(), upstream.URL, "invalid-auth")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("invalid auth returned status %d", w.Code)
	}
}

func TestMalformedMP4DoesNotPanic(t *testing.T) {
	_, _, auth := encryptedFixture(t)
	cases := [][]byte{nil, []byte("not an mp4"), {0, 0, 0, 255, 'm', 'o', 'o', 'v'}, mp4TestBox("moov", []byte{0, 0, 0, 255, 't', 'r', 'a', 'k'})}
	for _, data := range cases {
		if _, err := DecryptAudio(data, auth); err == nil {
			t.Errorf("accepted malformed MP4: %x", data)
		}
	}
	if sizes := parseStsz([]byte{0, 0, 0, 0, 0, 0, 0, 1, 255, 255, 255, 255}); sizes != nil {
		t.Fatal("accepted excessive sample count")
	}
}

func TestDecryptSubsamplesKeepsClearBytes(t *testing.T) {
	key := []byte("0123456789abcdef")
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("clear encrypted audio payload")
	iv := make([]byte, 16)
	encrypted := bytes.Clone(plain)
	cipher.NewCTR(block, iv).XORKeyStream(encrypted[6:], plain[6:])
	decoded := decryptSencSample(block, encrypted, encryptedSample{iv: [aes.BlockSize]byte{}, subsamples: []encryptedSubsample{{clear: 6, encrypted: uint32(len(plain) - 6)}}})
	if !bytes.Equal(decoded, plain) {
		t.Fatal("subsample decryption corrupted clear bytes")
	}
}

func TestServeAudioRejectsUpstreamFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", http.StatusForbidden) }))
	defer upstream.Close()
	w := httptest.NewRecorder()
	ServeAudio(w, httptest.NewRequest(http.MethodGet, "http://decrypt.example/", nil), upstream.Client(), upstream.URL, "auth")
	data, _ := io.ReadAll(w.Result().Body)
	if w.Code != http.StatusBadGateway || bytes.Contains(data, []byte("auth")) {
		t.Fatalf("unexpected upstream failure: %d %s", w.Code, data)
	}
}
