package metadata

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Exercise actual encoder output as well as the small structural fixtures.
// FFmpeg is optional test tooling and is never used by the application.
func TestPayloadAcceptsEncoderOutput(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	for _, test := range []struct {
		name   string
		format string
		args   []string
	}{
		{"MP3 CBR stereo", "mp3", []string{"-c:a", "libmp3lame", "-b:a", "320k", "-ac", "2", "-ar", "44100"}},
		{"MP3 VBR stereo", "mp3", []string{"-c:a", "libmp3lame", "-q:a", "2", "-ac", "2", "-ar", "48000"}},
		{"MP3 MPEG2 mono", "mp3", []string{"-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", "-ar", "22050"}},
		{"FLAC 16 bit", "flac", []string{"-c:a", "flac", "-sample_fmt", "s16", "-ac", "2", "-ar", "44100"}},
		{"FLAC 24 bit", "flac", []string{"-c:a", "flac", "-sample_fmt", "s32", "-ac", "2", "-ar", "48000"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			name := filepath.Join(t.TempDir(), "tone."+test.format)
			args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3"}
			args = append(args, test.args...)
			args = append(args, name)
			if output, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
				t.Fatalf("encode: %v: %s", err, output)
			}
			data, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ParseScan(bytes.NewReader(data), int64(len(data))); err != nil {
				t.Fatalf("parse encoder output: %v", err)
			}
			if err := CompareAudioPayload(context.Background(), bytes.NewReader(data), int64(len(data)), bytes.NewReader(data), int64(len(data))); err != nil {
				t.Fatalf("validate encoder output: %v", err)
			}
		})
	}
}
