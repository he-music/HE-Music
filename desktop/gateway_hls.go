package main

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const gatewayManifestLimit = 4 << 20

var gatewayURIAttribute = regexp.MustCompile(`(^|[:,])[ \t]*URI="([^"]*)"`)

func isGatewayManifest(response *http.Response) bool {
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	return strings.EqualFold(mediaType, "application/vnd.apple.mpegurl") || strings.EqualFold(mediaType, "application/x-mpegURL") || strings.HasSuffix(strings.ToLower(response.Request.URL.Path), ".m3u8")
}

func (g *NetworkGateway) writeManifest(w http.ResponseWriter, r *http.Request, response *http.Response, prefix string) {
	// Partial playlists cannot be parsed safely. Ask callers to retry without Range.
	if response.StatusCode == http.StatusPartialContent || response.Header.Get("Content-Range") != "" {
		http.Error(w, "partial HLS manifest is unsupported; retry without Range", http.StatusBadGateway)
		return
	}
	if response.StatusCode != http.StatusOK || r.Method == "HEAD" {
		copyDesktopGatewayHeaders(w.Header(), response.Header, true)
		w.WriteHeader(response.StatusCode)
		if r.Method != "HEAD" {
			streamGateway(w, response.Body)
		}
		return
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		http.Error(w, "encoded HLS manifest is unsupported", http.StatusBadGateway)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, gatewayManifestLimit+1))
	if err != nil || len(data) > gatewayManifestLimit {
		http.Error(w, "HLS manifest exceeds limit or is incomplete", http.StatusBadGateway)
		return
	}
	manifest, err := rewriteGatewayManifest(string(data), response.Request.URL, prefix)
	if err != nil {
		http.Error(w, "invalid HLS URI", http.StatusBadGateway)
		return
	}
	copyDesktopGatewayHeaders(w.Header(), response.Header, true)
	for _, key := range []string{"Content-Length", "Content-Encoding", "ETag", "Content-Md5", "Digest", "Content-Digest", "Repr-Digest", "Accept-Ranges", "Content-Range"} {
		w.Header().Del(key)
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.WriteHeader(response.StatusCode)
	_, _ = io.WriteString(w, manifest)
}

func rewriteGatewayManifest(manifest string, base *url.URL, prefix string) (string, error) {
	// Variable imports and secondary JSON documents need a shared rewriting
	// context. Reject them explicitly until that context is implemented; never
	// return a playlist that lets the player silently leave the Go gateway.
	if strings.Contains(manifest, "{$") {
		return "", errors.New("HLS variables are unsupported")
	}
	rewrite := func(raw string) (string, error) {
		uri, err := url.Parse(raw)
		if err != nil {
			return "", err
		}
		if strings.EqualFold(uri.Scheme, "data") {
			return raw, nil
		}
		target := base.ResolveReference(uri)
		if _, err = parseDesktopGatewayURL(target.String()); err != nil {
			return "", err
		}
		return prefix + "/__proxy/" + target.String(), nil
	}
	lines := strings.Split(manifest, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") {
			rewritten, err := rewrite(trimmed)
			if err != nil {
				return "", err
			}
			lines[i] = strings.Replace(line, trimmed, rewritten, 1)
			continue
		}
		// Plain comments are not tags. Attribute lists cover KEY, MAP, MEDIA,
		// I-FRAME-STREAM-INF, SESSION-KEY and future tags using the same grammar.
		if !strings.HasPrefix(trimmed, "#EXT") {
			continue
		}
		if strings.HasPrefix(trimmed, "#EXT-X-DEFINE:") ||
			strings.HasPrefix(trimmed, "#EXT-X-CONTENT-STEERING:") ||
			strings.Contains(trimmed, "X-ASSET-URI=") || strings.Contains(trimmed, "X-ASSET-LIST=") {
			return "", errors.New("unsupported HLS secondary resources")
		}
		var rewriteErr error
		lines[i] = gatewayURIAttribute.ReplaceAllStringFunc(line, func(attribute string) string {
			match := gatewayURIAttribute.FindStringSubmatch(attribute)
			rewritten, err := rewrite(match[2])
			if err != nil {
				rewriteErr = err
				return attribute
			}
			start := strings.Index(attribute, "\"")
			return attribute[:start+1] + rewritten + "\""
		})
		if rewriteErr != nil {
			return "", errors.New("invalid HLS attribute URI")
		}
	}
	return strings.Join(lines, "\n"), nil
}
