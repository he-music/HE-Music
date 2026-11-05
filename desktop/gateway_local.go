package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/he-music/HE-Music/desktop/metadata"
)

// Local resources share the application's loopback gateway. The caller
// supplies the absolute audio path; no resource tickets or per-file registrations.
func serveLocalResource(w http.ResponseWriter, r *http.Request, kind string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	name := r.URL.Query().Get("path")
	if !filepath.IsAbs(name) {
		http.Error(w, "absolute path required", http.StatusBadRequest)
		return
	}
	source, err := os.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer source.Close()
	stat, err := source.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if kind == "audio" {
		mime := localAudioExtensions[strings.ToLower(filepath.Ext(name))]
		if mime == "" {
			mime = "application/octet-stream"
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), source)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	base := strings.TrimSuffix(name, filepath.Ext(name))
	var data []byte
	mime := "text/plain; charset=utf-8"
	switch kind {
	case "artwork":
		data, mime = localResourceArtwork(ctx, source, stat.Size(), base)
	case "lyrics":
		data = localResourceLyrics(ctx, source, stat.Size(), base)
	default:
		http.NotFound(w, r)
		return
	}
	if len(data) == 0 || ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Content-Type", mime)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

const localResourceImageLimit = 8 << 20
const localResourceLyricsLimit = 1 << 20

func localResourceArtwork(ctx context.Context, source io.ReaderAt, size int64, base string) ([]byte, string) {
	parsed, _ := metadata.Parse(&displayReader{ctx: ctx, source: source, remaining: 16 << 20}, size)
	for _, front := range []bool{true, false} {
		for _, picture := range parsed.Pictures {
			if (picture.Type == 3) != front {
				continue
			}
			if mime := localResourceImageMIME(picture.Data); mime != "" {
				return picture.Data, mime
			}
		}
	}
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".JPG", ".JPEG", ".PNG", ".WEBP", ".GIF"} {
		data := readLocalResourceSidecar(ctx, base+ext, localResourceImageLimit)
		if mime := localResourceImageMIME(data); mime != "" {
			return data, mime
		}
	}
	return nil, ""
}

func localResourceImageMIME(data []byte) string {
	if len(data) == 0 || len(data) > localResourceImageLimit {
		return ""
	}
	switch mime := http.DetectContentType(data); mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return mime
	default:
		return ""
	}
}

func localResourceLyrics(ctx context.Context, source io.ReaderAt, size int64, base string) []byte {
	data := readLocalResourceSidecar(ctx, base+".lrc", localResourceLyricsLimit)
	if len(data) != 0 && utf8.Valid(data) {
		return bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	}
	parsed, err := metadata.ParseScan(&displayReader{ctx: ctx, source: source, remaining: 16 << 20}, size)
	if err != nil || len(parsed.Lyrics) > localResourceLyricsLimit || !utf8.ValidString(parsed.Lyrics) {
		return nil
	}
	return []byte(parsed.Lyrics)
}

func readLocalResourceSidecar(ctx context.Context, name string, limit int64) []byte {
	if ctx.Err() != nil {
		return nil
	}
	file, err := os.Open(name)
	if err != nil {
		return nil
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > limit {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit || ctx.Err() != nil {
		return nil
	}
	return data
}

type displayReader struct {
	ctx       context.Context
	source    io.ReaderAt
	mu        sync.Mutex
	remaining int64
}

func (r *displayReader) ReadAt(p []byte, off int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	r.mu.Lock()
	if int64(len(p)) > r.remaining {
		r.mu.Unlock()
		return 0, errMetadataLimit
	}
	r.remaining -= int64(len(p))
	r.mu.Unlock()
	return r.source.ReadAt(p, off)
}
