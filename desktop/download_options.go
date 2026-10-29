package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"path"
)

// DownloadOptions is the immutable, bounded native download configuration.
type DownloadOptions struct {
	RelativeDirectory string            `json:"relativeDirectory,omitempty"`
	WriteMetadata     bool              `json:"writeMetadata"`
	WriteCover        bool              `json:"writeCover"`
	WriteLyrics       bool              `json:"writeLyrics"`
	SaveSidecars      bool              `json:"saveSidecars"`
	Metadata          *DownloadMetadata `json:"metadata,omitempty"`
}
type DownloadMetadata struct {
	Title    string   `json:"title"`
	Artists  []string `json:"artists"`
	Album    string   `json:"album"`
	Lyrics   string   `json:"lyrics"`
	CoverURL string   `json:"coverURL,omitempty"`
}

const (
	downloadOptionStringLimit  = 4096
	downloadOptionLyricsLimit  = 1 << 20
	downloadOptionURLLimit     = 8192
	downloadOptionArtistsLimit = 64
	downloadOptionTotalLimit   = 2 << 20
)

var errDownloadOptions = errors.New("download options rejected")

func downloadNativeOptionsSnapshot(in *DownloadOptions) (*DownloadOptions, error) {
	if in == nil {
		return nil, nil
	}
	if err := validateDownloadNativeOptions(in); err != nil {
		return nil, err
	}
	out := *in
	if !in.WriteMetadata && !in.WriteCover && !in.WriteLyrics && !in.SaveSidecars {
		out.Metadata = nil
		if out.RelativeDirectory == "" {
			return nil, nil
		}
		return &out, nil
	}
	if in.Metadata != nil {
		m := *in.Metadata
		m.Artists = append([]string(nil), in.Metadata.Artists...)
		out.Metadata = &m
	}
	return &out, nil
}

func validateDownloadNativeOptions(o *DownloadOptions) error {
	if o == nil {
		return nil
	}
	if len(o.RelativeDirectory) > 240 || validateLocalRelativePath(o.RelativeDirectory) != nil && o.RelativeDirectory != "" {
		return errDownloadOptions
	}
	if !o.WriteMetadata && !o.WriteCover && !o.WriteLyrics && !o.SaveSidecars {
		return nil
	}
	if o.Metadata == nil {
		return errDownloadOptions
	}
	m := o.Metadata
	if len(m.Title) > downloadOptionStringLimit || len(m.Album) > downloadOptionStringLimit || len(m.Lyrics) > downloadOptionLyricsLimit || len(m.CoverURL) > downloadOptionURLLimit || len(m.Artists) > downloadOptionArtistsLimit {
		return errDownloadOptions
	}
	total := len(m.Title) + len(m.Album) + len(m.Lyrics) + len(m.CoverURL)
	for _, a := range m.Artists {
		if len(a) > downloadOptionStringLimit {
			return errDownloadOptions
		}
		total += len(a)
	}
	if total > downloadOptionTotalLimit {
		return errDownloadOptions
	}
	if o.WriteCover && m.CoverURL != "" && !downloadNativeCoverURL(m.CoverURL) {
		return errDownloadOptions
	}
	if o.WriteCover && m.CoverURL == "" {
		return errDownloadOptions
	}
	return nil
}
func downloadNativeCoverURL(raw string) bool {
	u, err := url.Parse(raw)
	return len(raw) <= downloadOptionURLLimit && err == nil && u.User == nil && u.Fragment == "" && u.Opaque == "" && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != ""
}
func downloadNativeOptionsFingerprint(o *DownloadOptions) string {
	b, _ := json.Marshal(o)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func downloadNativeTarget(filename string, o *DownloadOptions) (string, error) {
	if !downloadFilename(filename) {
		return "", errDownloadOptions
	}
	if o == nil || o.RelativeDirectory == "" {
		return filename, nil
	}
	if validateLocalRelativePath(o.RelativeDirectory) != nil {
		return "", errDownloadOptions
	}
	return path.Join(o.RelativeDirectory, filename), nil
}
func downloadCoverURL(raw string) bool { return downloadNativeCoverURL(raw) }
