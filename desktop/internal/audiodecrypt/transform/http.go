// 来源与同步说明见 ../README.md。
package transform

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const maxAudioBytes = 128 << 20

type AudioOptions struct {
	MaxRequests int
	CacheBytes  int64
	CacheTTL    time.Duration
}

type audioEntry struct {
	key     [32]byte
	data    []byte
	expires time.Time
}

// AudioServer bounds both decoding and slow response readers. Cached plaintext
// is immutable and keyed by the complete upstream URL and all prepared parameters.
type AudioServer struct {
	client   *http.Client
	options  AudioOptions
	requests chan struct{}
	decode   chan struct{}
	mu       sync.Mutex
	entries  map[[32]byte]*list.Element
	flights  map[[32]byte]*audioFlight
	lru      *list.List
	bytes    int64
}

func NewAudioServer(client *http.Client, options AudioOptions) (*AudioServer, error) {
	if client == nil || options.MaxRequests < 1 || options.CacheBytes < 0 || (options.CacheBytes > 0 && options.CacheTTL <= 0) {
		return nil, errors.New("invalid audio server options")
	}
	return &AudioServer{
		client: client, options: options, requests: make(chan struct{}, options.MaxRequests),
		decode: make(chan struct{}, 1), entries: make(map[[32]byte]*list.Element), lru: list.New(),
		flights: make(map[[32]byte]*audioFlight),
	}, nil
}

// ServeAudio serves prepared sample parameters without retaining a cache.
func ServeAudio(w http.ResponseWriter, r *http.Request, client *http.Client, rawURL, auth string) {
	server, err := NewAudioServer(client, AudioOptions{MaxRequests: 1})
	if err != nil {
		http.Error(w, "audio service unavailable", http.StatusServiceUnavailable)
		return
	}
	server.ServeAudio(w, r, rawURL, auth)
}

func (s *AudioServer) ServeAudio(w http.ResponseWriter, r *http.Request, rawURL, auth string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	select {
	case s.requests <- struct{}{}:
		defer func() { <-s.requests }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "audio service busy", http.StatusServiceUnavailable)
		return
	}
	key := sha256.Sum256([]byte(rawURL + "\x00" + auth))
	data := s.cached(key)
	if data == nil && r.Method == http.MethodHead {
		s.serveHead(w, r, rawURL, auth)
		return
	}
	if data == nil {
		var err error
		data, err = s.load(r.Context(), key, rawURL, auth)
		if err != nil {
			http.Error(w, "audio upstream or decryption unavailable", http.StatusBadGateway)
			return
		}
	}
	audioHeaders(w, r)
	http.ServeContent(w, r, "audio.m4a", time.Time{}, bytes.NewReader(data))
}

type audioFlight struct {
	done chan struct{}
	data []byte
	err  error
}

func (s *AudioServer) load(ctx context.Context, key [32]byte, rawURL, auth string) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		if flight := s.flights[key]; flight != nil {
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-flight.done:
				if errors.Is(flight.err, context.Canceled) || errors.Is(flight.err, context.DeadlineExceeded) {
					continue
				}
				return flight.data, flight.err
			}
		}
		flight := &audioFlight{done: make(chan struct{}), err: errors.New("audio load interrupted")}
		s.flights[key] = flight
		s.mu.Unlock()
		return s.loadFlight(ctx, key, rawURL, auth, flight)
	}
}

// loadFlight 仅由创建 flight 的请求调用，函数退出时发布结果并释放等待者。
func (s *AudioServer) loadFlight(ctx context.Context, key [32]byte, rawURL, auth string, flight *audioFlight) ([]byte, error) {
	defer func() {
		s.mu.Lock()
		delete(s.flights, key)
		close(flight.done)
		s.mu.Unlock()
	}()
	flight.data, flight.err = s.download(ctx, key, rawURL, auth)
	if ctx.Err() != nil {
		flight.data, flight.err = nil, ctx.Err()
	}
	return flight.data, flight.err
}

func (s *AudioServer) download(ctx context.Context, key [32]byte, rawURL, auth string) ([]byte, error) {
	select {
	case s.decode <- struct{}{}:
		defer func() { <-s.decode }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if data := s.cached(key); data != nil {
		return data, nil
	}
	p, err := Parse(auth)
	if err != nil || p.Kind != SampleCTR {
		return nil, errors.New("invalid sample parameters")
	}
	resp, err := s.fetch(ctx, http.MethodGet, rawURL, p)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAudioBytes+1))
	if err != nil || len(data) > maxAudioBytes {
		return nil, errors.New("could not read complete audio")
	}
	decoded, err := DecryptSamples(data, p, true)
	if err != nil {
		return nil, err
	}
	s.store(key, decoded, rawURL)
	return decoded, nil
}

func (s *AudioServer) fetch(ctx context.Context, method, rawURL string, p Parameters) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if req.URL.Scheme != "https" && req.URL.Scheme != "http" {
		return nil, errors.New("invalid audio URL scheme")
	}
	req.Header.Set("User-Agent", p.UserAgent)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK || resp.ContentLength > maxAudioBytes {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("invalid audio upstream response: %d", resp.StatusCode)
	}
	return resp, nil
}

func (s *AudioServer) serveHead(w http.ResponseWriter, r *http.Request, rawURL, auth string) {
	p, err := Parse(auth)
	if err != nil || p.Kind != SampleCTR {
		http.Error(w, "invalid sample parameters", http.StatusBadGateway)
		return
	}
	resp, err := s.fetch(r.Context(), http.MethodHead, rawURL, p)
	if err != nil {
		http.Error(w, "audio upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	audioHeaders(w, r)
	// Decryption preserves the MP4 byte length; HEAD need not fetch its samples.
	if resp.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(http.StatusOK)
}

func audioHeaders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "audio/mp4")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
}

func (s *AudioServer) cached(key [32]byte) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	if element := s.entries[key]; element != nil {
		s.lru.MoveToFront(element)
		return element.Value.(*audioEntry).data
	}
	return nil
}

func (s *AudioServer) store(key [32]byte, data []byte, rawURL string) {
	if int64(len(data)) > s.options.CacheBytes || s.options.CacheBytes == 0 {
		return
	}
	expires := time.Now().Add(s.options.CacheTTL)
	if u, err := url.Parse(rawURL); err == nil {
		for _, name := range []string{"expire", "expires", "expires_at"} {
			if value, err := strconv.ParseInt(u.Query().Get(name), 10, 64); err == nil {
				if value > 1e12 {
					value /= 1000
				}
				if deadline := time.Unix(value, 0).Add(-5 * time.Second); deadline.Before(expires) {
					expires = deadline
				}
			}
		}
	}
	if !time.Now().Before(expires) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	if previous := s.entries[key]; previous != nil {
		s.remove(previous)
	}
	for s.lru.Len() >= 128 || s.bytes+int64(len(data)) > s.options.CacheBytes {
		s.remove(s.lru.Back())
	}
	entry := &audioEntry{key: key, data: data, expires: expires}
	s.entries[key] = s.lru.PushFront(entry)
	s.bytes += int64(len(data))
}

func (s *AudioServer) expire() {
	for element := s.lru.Back(); element != nil; {
		previous := element.Prev()
		if !time.Now().Before(element.Value.(*audioEntry).expires) {
			s.remove(element)
		}
		element = previous
	}
}

func (s *AudioServer) remove(element *list.Element) {
	entry := element.Value.(*audioEntry)
	delete(s.entries, entry.key)
	s.bytes -= int64(len(entry.data))
	s.lru.Remove(element)
}
