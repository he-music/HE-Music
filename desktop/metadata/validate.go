package metadata

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
)

// ValidateAudioPayload validates one immutable source using the same strict
// layouts as CompareAudioPayload. Callers own file identity/version checks.
// It validates encoded framing, not decoded PCM. ReaderAt must return on its own;
// cancellation is checked before and after each bounded read.
func ValidateAudioPayload(ctx context.Context, reader io.ReaderAt, size int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if reader == nil {
		return fmt.Errorf("%w: nil reader", ErrInvalidPayload)
	}
	if size <= 0 {
		return ErrUnsupportedPayload
	}
	additional, err := AdditionalPayloadFormat(ctx, reader, size)
	if err != nil {
		return err
	}
	source := payloadSource{ctx, reader, size}
	h := &formatPayloadHash{Hash: sha256.New()}
	if additional {
		err = hashFormatPayload(source, h)
	} else {
		var span payloadSpan
		span, err = inspectPayload(source)
		if err == nil {
			err = hashFormatRange(source, h, span.start, span.end)
		}
	}
	if canceled := ctx.Err(); canceled != nil {
		return canceled
	}
	return err
}
