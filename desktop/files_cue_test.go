package main

import (
	"encoding/binary"
	"path/filepath"
	"strings"
	"testing"
)

const sampleCue = `FILE "整轨 专辑.wav" WAVE
  TRACK 01 AUDIO
    TITLE "第一首"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    PERFORMER "第二位"
    INDEX 00 00:00:58
    INDEX 01 00:01:37
`

func TestCueParsingSingleFileAndIndexes(t *testing.T) {
	name, sheet := parseCue("\uFEFFTITLE \"测试专辑\"\r\nPERFORMER 主唱\r\n" + sampleCue)
	if name != "整轨 专辑.wav" || sheet == nil || len(sheet.Tracks) != 2 ||
		sheet.Title != "测试专辑" || sheet.Performer != "主唱" ||
		sheet.Tracks[0] != (CueTrack{Number: 1, Title: "第一首", StartFrame: 0}) ||
		sheet.Tracks[1] != (CueTrack{Number: 2, Performer: "第二位", StartFrame: 112}) {
		t.Fatalf("parsed %q: %+v", name, sheet)
	}
}

func TestCueRejectsUnsupportedSheets(t *testing.T) {
	for name, input := range map[string]string{
		"outside":         strings.Replace(sampleCue, "整轨 专辑.wav", "../audio.wav", 1),
		"absolute":        strings.Replace(sampleCue, "整轨 专辑.wav", "/audio.wav", 1),
		"multi-file":      sampleCue + "FILE other.flac WAVE\n",
		"bad-time":        strings.Replace(sampleCue, "00:01:37", "00:01:75", 1),
		"same-time":       strings.Replace(sampleCue, "00:01:37", "00:00:00", 1),
		"missing-index":   strings.Replace(sampleCue, "INDEX 01 00:00:00", "INDEX 00 00:00:00", 1),
		"duplicate-index": sampleCue + "    INDEX 01 00:02:00\n",
		"invalid-utf8":    sampleCue + "\xff",
	} {
		t.Run(name, func(t *testing.T) {
			if _, sheet := parseCue(input); sheet != nil {
				t.Fatalf("accepted unsupported sheet: %+v", sheet)
			}
		})
	}
}

func TestScanCombinesCueWithOneAuthorizedAudioFile(t *testing.T) {
	actor, ctx, epoch, token, path := scanTestGrant(t)
	// 2 s of mono 16-bit PCM; scan metadata determines the last track's end.
	const rate = 8000
	const sampleBytes = rate * 2 * 2
	wav := make([]byte, 44+sampleBytes)
	copy(wav, "RIFF\x00\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00")
	binary.LittleEndian.PutUint32(wav[4:], uint32(len(wav)-8))
	binary.LittleEndian.PutUint32(wav[24:], rate)
	binary.LittleEndian.PutUint32(wav[28:], rate*2)
	binary.LittleEndian.PutUint16(wav[32:], 2)
	binary.LittleEndian.PutUint16(wav[34:], 16)
	copy(wav[36:], "data")
	binary.LittleEndian.PutUint32(wav[40:], sampleBytes)
	scanTestWrite(t, filepath.Join(path, "整轨 专辑.wav"), wav)
	scanTestWrite(t, filepath.Join(path, "不必同名.CUE"), []byte(sampleCue))
	entries, issues := scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(issues) != 0 || len(entries) != 1 || entries[0].Cue == nil ||
		len(entries[0].Cue.Tracks) != 2 || entries[0].Metadata.DurationSeconds != 2 {
		t.Fatalf("scan did not join CUE and audio: %+v; %+v", entries, issues)
	}

	scanTestWrite(t, filepath.Join(path, "不必同名.CUE"), []byte(strings.Replace(sampleCue, "00:01:37", "00:02:00", 1)))
	entries, _ = scanTestDrain(t, scanTestJob(t, actor.state, ctx, epoch, token))
	if len(entries) != 1 || entries[0].Cue != nil {
		t.Fatalf("invalid end must fall back to the entire file: %+v", entries)
	}
}
