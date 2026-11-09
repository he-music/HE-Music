package metadata

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
)

// CompareMetadataPayload checks preservation during tag edits. Download acceptance
// continues to use CompareAudioPayload to validate the incoming audio layout.
// Existing opaque bytes are protected like audio, without requiring them to be
// decodable frames. Readers must remain immutable throughout the comparison.
func CompareMetadataPayload(ctx context.Context, left io.ReaderAt, leftSize int64, right io.ReaderAt, rightSize int64) error {
	var sums [2][32]byte
	for i, source := range []payloadSource{{ctx, left, leftSize}, {ctx, right, rightSize}} {
		if err := ctx.Err(); err != nil {
			return err
		}
		if source.r == nil || source.size <= 0 {
			return ErrInvalidPayload
		}
		h := &formatPayloadHash{Hash: sha256.New()}
		if err := hashMetadataPayload(source, h); err != nil {
			return fmt.Errorf("payload %d: %w", i, err)
		}
		copy(sums[i][:], h.Sum(nil))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if sums[0] != sums[1] {
		return ErrAudioPayloadChanged
	}
	return nil
}

func hashMetadataPayload(s payloadSource, h *formatPayloadHash) error {
	kind, err := additionalPayloadKind(s)
	if err != nil {
		return err
	}
	switch kind {
	case "", "adts", "mac":
		var magic [4]byte
		if err := s.read(0, magic[:]); err != nil {
			return err
		}
		if string(magic[:]) == "fLaC" {
			return hashFLACMetadataPayload(s, h)
		}
		start, end, err := formatRawBounds(s)
		if err != nil {
			return err
		}
		if kind == "" {
			var sync [2]byte
			if err := s.read(start, sync[:]); err != nil {
				return err
			}
			if sync[0] != 0xff || sync[1]&0xe0 != 0xe0 {
				return ErrUnsupportedPayload
			}
			kind = "mp3"
		}
		return hashFormatSection(s, h, kind, start, end)
	default:
		end, err := metadataContainerEnd(s)
		if err != nil {
			return err
		}
		body := s
		body.size = end
		if err := hashFormatPayload(body, h); err != nil {
			return err
		}
		return hashFormatSection(s, h, "trailer", end, s.size)
	}
}

// Metadata writers may regenerate comments, pictures and padding. Protect every
// other block (including unknown extensions), STREAMINFO and the complete suffix
// after the last metadata block. Frame decoding is unnecessary for preservation.
func hashFLACMetadataPayload(s payloadSource, h *formatPayloadHash) error {
	h.Write([]byte("flac"))
	for off, blocks := int64(4), 0; ; blocks++ {
		if blocks >= 65536 {
			return ErrUnsupportedPayload
		}
		var header [4]byte
		if err := s.read(off, header[:]); err != nil {
			return err
		}
		kind := header[0] & 127
		size := int64(header[1])<<16 | int64(header[2])<<8 | int64(header[3])
		off += 4
		if size > s.size-off || kind == 127 || blocks == 0 && (kind != 0 || size != 34) || blocks > 0 && kind == 0 {
			return ErrInvalidPayload
		}
		if kind != 1 && kind != 4 && kind != 6 {
			if err := hashFormatSection(s, h, fmt.Sprintf("block-%d", kind), off, off+size); err != nil {
				return err
			}
		}
		off += size
		if header[0]&128 != 0 {
			if off >= s.size {
				return ErrInvalidPayload
			}
			return hashFormatSection(s, h, "audio-and-trailer", off, s.size)
		}
	}
}
