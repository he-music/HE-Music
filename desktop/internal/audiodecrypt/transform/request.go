package transform

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ServeAudioRequest 只接受版本化执行参数。validate 由宿主实施上游访问策略。
func ServeAudioRequest(w http.ResponseWriter, r *http.Request, client *http.Client, samples *AudioServer, validate func(*url.URL) error) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	target, p, err := parseAudioSource(r, validate)
	if err != nil {
		http.Error(w, "invalid audio source", http.StatusBadRequest)
		return
	}
	if client == nil {
		http.Error(w, "audio unavailable", http.StatusServiceUnavailable)
		return
	}
	if p.Kind == SampleCTR {
		if samples == nil {
			http.Error(w, "audio unavailable", http.StatusServiceUnavailable)
			return
		}
		samples.ServeAudio(w, r, target.String(), r.URL.Query().Get("audio_params"))
		return
	}
	serveStreamAudio(w, r, client, target, p)
}

func serveStreamAudio(w http.ResponseWriter, r *http.Request, client *http.Client, target *url.URL, p Parameters) {
	if strings.Contains(r.Header.Get("Range"), ",") {
		http.Error(w, "multiple ranges unsupported", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), nil)
	if err != nil {
		http.Error(w, "invalid audio source", http.StatusBadRequest)
		return
	}
	req.Header.Set("Accept-Encoding", "identity")
	if p.UserAgent != "" {
		req.Header.Set("User-Agent", p.UserAgent)
	}
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
	offset, err := AudioOffset(response)
	if err != nil {
		http.Error(w, "invalid audio response", http.StatusBadGateway)
		return
	}
	reader, err := NewReader(response.Body, p, offset)
	if err != nil {
		http.Error(w, "audio transform unavailable", http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	mime := map[string]string{"mp3": "audio/mpeg", "flac": "audio/flac", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac", "ogg": "audio/ogg", "opus": "audio/ogg"}[strings.ToLower(r.URL.Query().Get("format"))]
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, reader)
	}
}

func parseAudioSource(r *http.Request, validate func(*url.URL) error) (*url.URL, Parameters, error) {
	query := r.URL.Query()
	target, err := url.Parse(query.Get("url"))
	p, paramErr := Parse(query.Get("audio_params"))
	if err != nil || paramErr != nil || target == nil || target.Host == "" || target.User != nil || target.Fragment != "" || (target.Scheme != "https" && target.Scheme != "http") {
		return nil, Parameters{}, errors.New("invalid audio source")
	}
	if validate != nil {
		if err := validate(target); err != nil {
			return nil, Parameters{}, errors.New("invalid audio source")
		}
	}
	return target, p, nil
}

// AudioOffset 使用实际响应偏移，包含上游忽略 Range 的情况。
func AudioOffset(response *http.Response) (int64, error) {
	invalid := errors.New("invalid audio range")
	encoding := response.Header.Get("Content-Encoding")
	if response.Uncompressed || (encoding != "" && encoding != "identity") || strings.HasPrefix(response.Header.Get("Content-Type"), "multipart/") {
		return 0, invalid
	}
	if response.StatusCode == http.StatusOK {
		if response.Header.Get("Content-Range") != "" {
			return 0, invalid
		}
		return 0, nil
	}
	value, ok := strings.CutPrefix(response.Header.Get("Content-Range"), "bytes ")
	interval, total, found := strings.Cut(value, "/")
	start, end, split := strings.Cut(interval, "-")
	begin, beginErr := strconv.ParseInt(start, 10, 64)
	last, endErr := strconv.ParseInt(end, 10, 64)
	if !ok || !found || !split || beginErr != nil || endErr != nil || begin < 0 || last < begin || last > maxOffset {
		return 0, invalid
	}
	if total != "*" {
		length, err := strconv.ParseInt(total, 10, 64)
		if err != nil || length <= last {
			return 0, invalid
		}
	}
	if response.ContentLength >= 0 && response.ContentLength != last-begin+1 {
		return 0, invalid
	}
	return begin, nil
}
