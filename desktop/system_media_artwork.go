package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

const (
	systemMediaArtworkMaxBytes   = 2 << 20
	systemMediaArtworkMaxEncoded = ((systemMediaArtworkMaxBytes + 2) / 3) * 4
	systemMediaArtworkMaxSide    = 2048
	systemMediaArtworkMaxPixels  = 2048 * 2048
)

// SetArtwork targets an already accepted snapshot. Allocate revision before
// preparing artwork; a later song, configuration or owner rejects this result.
// base64 is raw standard padded PNG/JPEG data, never a URL, data URL or path.
// An empty string clears only the current snapshot's artwork.
func (s *SystemMedia) SetArtwork(ctx context.Context, generation, revision uint64, trackID, base64 string) error {
	return desktopLifecycle.call(ctx, true, func() error {
		return s.state.artwork(ctx, generation, revision, trackID, base64)
	})
}

func (s *systemMediaState) artwork(ctx context.Context, generation, revision uint64, trackID, encoded string) error {
	if !s.owns(ctx, generation) || !s.enabled || !s.showing || revision == 0 || revision != s.revision || trackID == "" || trackID != s.trackID {
		return errors.New("system media artwork target is no longer active")
	}
	artwork, err := decodeSystemMediaArtwork(encoded)
	if err != nil {
		return err
	}
	// Info advances the module's current position at its current Rate. Reusing
	// the original Set snapshot would rewind playback or restore an old pause.
	// This is module state, not evidence of what an OS panel displays.
	info, showing := s.media.Info()
	if !showing || !s.owns(ctx, generation) {
		return errors.New("system media artwork snapshot is no longer showing")
	}
	info.Artwork = artwork
	s.media.Set(info)
	return nil
}

func decodeSystemMediaArtwork(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, nil
	}
	if len(encoded) > systemMediaArtworkMaxEncoded || strings.ContainsAny(encoded, "\r\n") {
		return nil, errors.New("system media artwork encoding exceeds limits or contains line breaks")
	}
	artwork, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(artwork) == 0 || len(artwork) > systemMediaArtworkMaxBytes {
		return nil, errors.New("invalid system media artwork base64 or byte length")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(artwork))
	if err != nil || (format != "png" && format != "jpeg") ||
		config.Width <= 0 || config.Height <= 0 ||
		config.Width > systemMediaArtworkMaxSide || config.Height > systemMediaArtworkMaxSide ||
		config.Width > systemMediaArtworkMaxPixels/config.Height {
		return nil, errors.New("invalid system media artwork format or dimensions")
	}
	// DecodeConfig alone accepts a valid header with a truncated/broken body.
	// Dimensions are bounded before allocating the decoded pixel buffer.
	decoded, decodedFormat, err := image.Decode(bytes.NewReader(artwork))
	if err != nil || decodedFormat != format || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
		return nil, errors.New("invalid system media artwork image")
	}
	return artwork, nil
}
