package main

import (
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/transform"
)

// 播放和下载共用版本化执行参数；网关不识别平台名或原始密钥。
func (g *NetworkGateway) serveAudio(w http.ResponseWriter, r *http.Request, media *http.Client) {
	if media == nil {
		http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
		return
	}
	client := gatewayAudioClient(media)
	g.mu.Lock()
	var err error
	if g.audio == nil {
		g.audio, err = transform.NewAudioServer(client, transform.AudioOptions{MaxRequests: 4, CacheBytes: 128 << 20, CacheTTL: time.Minute})
	}
	audio := g.audio
	g.mu.Unlock()
	if err != nil {
		http.Error(w, "audio unavailable", http.StatusServiceUnavailable)
		return
	}
	transform.ServeAudioRequest(w, r, client, audio, func(target *url.URL) error {
		_, err := parseDesktopGatewayURL(target.String())
		return err
	})
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
