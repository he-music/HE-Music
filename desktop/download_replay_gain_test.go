package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestDownloadReplayGainWritesOnlyOptedInAndPreservesExisting(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg 用于生成隔离的音频样本")
	}
	path := filepath.Join(t.TempDir(), "sample.flac")
	if output, err := exec.CommandContext(t.Context(), ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", path).CombinedOutput(); err != nil {
		t.Fatalf("生成 FLAC: %v: %s", err, output)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	requireTestNoError(t, err)
	t.Cleanup(func() { _ = file.Close() })
	check := func(want *metadata.ReplayGain) {
		t.Helper()
		info, err := file.Stat()
		requireTestNoError(t, err)
		tags, err := metadata.ParseScan(file, info.Size())
		requireTestNoError(t, err)
		if !reflect.DeepEqual(tags.ReplayGain, want) {
			t.Fatalf("读取标签 = %+v，预期 %+v", tags.ReplayGain, want)
		}
	}
	first := &metadata.ReplayGain{GainDB: -8.315, Peak: new(1.0)}
	options := &DownloadOptions{WriteMetadata: true, Metadata: &DownloadMetadata{Title: "新标题", ReplayGain: first}}
	requireTestNoError(t, downloadNativeMetadata(t.Context(), nil, nil, file, "sample.flac", options))
	check(nil)
	options.WriteMetadata = false
	options.WriteReplayGain = true
	requireTestNoError(t, downloadNativeMetadata(t.Context(), nil, nil, file, "sample.flac", options))
	check(first)
	options.Metadata.ReplayGain = &metadata.ReplayGain{GainDB: -4}
	requireTestNoError(t, downloadNativeMetadata(t.Context(), nil, nil, file, "sample.flac", options))
	check(first)
}
