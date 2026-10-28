package main

import (
	"context"
	"os"
)

func init() {
	metadataAudioDrain = func(ctx context.Context, files *NativeFiles, info os.FileInfo) (func(), error) {
		return audioServerFor(&files.state).quiesce(ctx, info)
	}
}
