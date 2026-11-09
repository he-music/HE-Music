package metadata

import (
	"context"
	"io"
	"os"
)

func editPreservingTrailer(ctx context.Context, src WorkingCopy, size int64, patch Patch) error {
	source := payloadSource{ctx, src, size}
	end, err := metadataContainerEnd(source)
	if err != nil {
		return err
	}
	if end == size {
		return editWorkingCopy(ctx, src, size, patch)
	}

	// Some writers rebuild only the declared container and discard bytes outside
	// it. Stream those bytes through a private temporary file, never into memory
	// proportional to the song size, and append them after the updated container.
	tail, err := os.CreateTemp("", "hemusic-metadata-trailer-*")
	if err != nil {
		return err
	}
	defer os.Remove(tail.Name())
	defer tail.Close()
	reader := io.NewSectionReader(payloadContextReader{source}, end, size-end)
	if _, err := io.Copy(tail, reader); err != nil {
		return err
	}
	body := &tailWorkingCopy{WorkingCopy: src, size: end}
	if err := editWorkingCopy(ctx, body, end, patch); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	savedTail := payloadSource{ctx, tail, size - end}
	reader = io.NewSectionReader(payloadContextReader{savedTail}, 0, size-end)
	n, err := io.Copy(io.NewOffsetWriter(src, body.size), reader)
	if err != nil {
		return err
	}
	return src.Truncate(body.size + n)
}
