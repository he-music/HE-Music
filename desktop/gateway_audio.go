package main

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/mg"
	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/qmc"
	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/soda"
)

// 解密参数只存在于本次请求；播放和下载共用同一个受网关前缀保护的入口。
func (g *NetworkGateway) serveAudio(w http.ResponseWriter, r *http.Request, media *http.Client) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "audio requires GET or HEAD", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	target, err := parseDesktopGatewayURL(query.Get("url"))
	platform, key := query.Get("platform"), query.Get("key")
	if err != nil || target.Fragment != "" || key == "" || len(key) > 16<<10 || (platform != "kuwo" && platform != "migu" && platform != "soda") {
		http.Error(w, "invalid audio source", http.StatusBadRequest)
		return
	}
	if media == nil {
		http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
		return
	}
	client := gatewayAudioClient(media)
	if platform == "soda" {
		g.mu.Lock()
		if g.audio == nil {
			g.audio, err = soda.NewAudioServer(client, soda.AudioOptions{MaxRequests: 4, CacheBytes: 128 << 20, CacheTTL: time.Minute})
		}
		audio := g.audio
		g.mu.Unlock()
		if err != nil {
			http.Error(w, "audio unavailable", http.StatusServiceUnavailable)
			return
		}
		audio.ServeAudio(w, r, target.String(), key)
		return
	}
	serveStreamAudio(w, r, client, target.String(), platform, key)
}

func serveStreamAudio(w http.ResponseWriter, r *http.Request, client *http.Client, rawURL, platform, key string) {
	if strings.Contains(r.Header.Get("Range"), ",") {
		http.Error(w, "multiple audio ranges are unsupported", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, rawURL, nil)
	if err != nil {
		http.Error(w, "invalid audio source", http.StatusBadRequest)
		return
	}
	req.Header.Set("Accept-Encoding", "identity")
	for _, name := range []string{"Range", "If-Range"} {
		if value := r.Header.Get(name); value != "" {
			req.Header.Set(name, value)
		}
	}
	response, err := client.Do(req)
	if err != nil {
		http.Error(w, "audio upstream unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		if response.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			w.Header().Set("Content-Range", response.Header.Get("Content-Range"))
			http.Error(w, "audio range unavailable", http.StatusRequestedRangeNotSatisfiable)
		} else {
			http.Error(w, "audio upstream unavailable", http.StatusBadGateway)
		}
		return
	}
	offset, err := gatewayAudioOffset(response)
	if err != nil {
		http.Error(w, "invalid audio response", http.StatusBadGateway)
		return
	}
	decoder, err := gatewayAudioDecoder(response.Body, platform, key, offset)
	if err != nil {
		http.Error(w, "audio decryption unavailable", http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	mime := localAudioExtensions["."+strings.ToLower(r.URL.Query().Get("format"))]
	if platform == "kuwo" {
		mime = "audio/flac"
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead {
		streamGateway(w, decoder)
	}
}

func gatewayAudioClient(media *http.Client) *http.Client {
	client := *media
	client.Jar = nil
	client.Timeout = 2 * time.Minute
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many audio redirects")
		}
		req.Header.Del("Referer")
		_, err := parseDesktopGatewayURL(req.URL.String())
		return err
	}
	return &client
}

func gatewayAudioOffset(response *http.Response) (int, error) {
	invalid := errors.New("invalid audio range")
	encoding := response.Header.Get("Content-Encoding")
	if response.Uncompressed || (encoding != "" && encoding != "identity") || strings.HasPrefix(response.Header.Get("Content-Type"), "multipart/") {
		return 0, invalid
	}
	if response.StatusCode == http.StatusOK {
		if response.Header.Get("Content-Range") != "" {
			return 0, invalid
		}
		return 0, nil // 上游忽略 Range 时必须从文件起点解密。
	}
	value, ok := strings.CutPrefix(response.Header.Get("Content-Range"), "bytes ")
	interval, total, found := strings.Cut(value, "/")
	start, end, split := strings.Cut(interval, "-")
	begin, beginErr := strconv.ParseInt(start, 10, strconv.IntSize)
	last, endErr := strconv.ParseInt(end, 10, strconv.IntSize)
	if !ok || !found || !split || beginErr != nil || endErr != nil || begin < 0 || last < begin {
		return 0, invalid
	}
	if total != "*" {
		length, err := strconv.ParseInt(total, 10, strconv.IntSize)
		if err != nil || length <= last {
			return 0, invalid
		}
	}
	if response.ContentLength >= 0 && response.ContentLength != last-begin+1 {
		return 0, invalid
	}
	return int(begin), nil
}

func gatewayAudioDecoder(body io.Reader, platform, key string, offset int) (decoder io.Reader, err error) {
	// 密钥来自上游接口，格式错误不应让 QMC 密钥解析中的越界终止请求。
	defer func() {
		if recover() != nil {
			decoder, err = nil, errors.New("invalid audio key")
		}
	}()
	if platform == "kuwo" {
		return qmc.NewDecoder(body, key, offset)
	}
	return mg.NewAudio3DDecoder(body, key, offset), nil
}
