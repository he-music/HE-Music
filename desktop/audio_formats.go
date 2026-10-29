package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var localAudioExtensions = map[string]string{
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
	".aac": "audio/aac", ".webm": "audio/webm", ".m4a": "audio/mp4",
	".mp4": "audio/mp4", ".ogg": "audio/ogg", ".aiff": "audio/aiff",
	".aif": "audio/aiff", ".ape": "audio/ape",
}

func supportedLocalAudioName(name string) bool {
	_, supported := localAudioExtensions[strings.ToLower(filepath.Ext(name))]
	return supported
}

func localAudioContainerMatches(container, name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".wav":
		return container == "riff" || container == "wav"
	case ".aif", ".aiff":
		return container == "aiff"
	case ".m4a", ".mp4":
		return container == "mp4"
	case ".webm":
		return container == "matroska"
	case ".ape":
		return container == "mac"
	default:
		return "."+container == ext
	}
}

// Playback is independent of tag parsing. Only a small header is inspected;
// the authorized file is served with Range without reading it into memory.
func localAudioMIME(file *os.File) (string, error) {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return "", errLocalAudio
	}
	var data [16]byte
	n, readErr := file.ReadAt(data[:], 0)
	if readErr != nil && readErr != io.EOF {
		return "", readErr
	}
	header := data[:n]
	switch {
	case bytes.HasPrefix(header, []byte("fLaC")):
		return "audio/flac", nil
	case bytes.HasPrefix(header, []byte("ID3")):
		if strings.EqualFold(filepath.Ext(file.Name()), ".aac") {
			return "audio/aac", nil
		}
		return "audio/mpeg", nil
	case n >= 12 && (string(header[:4]) == "RIFF" || string(header[:4]) == "RF64") && string(header[8:12]) == "WAVE":
		return "audio/wav", nil
	case n >= 12 && string(header[:4]) == "FORM" && (string(header[8:12]) == "AIFF" || string(header[8:12]) == "AIFC"):
		return "audio/aiff", nil
	case bytes.HasPrefix(header, []byte("OggS")):
		return "audio/ogg", nil
	case n >= 8 && string(header[4:8]) == "ftyp":
		return "audio/mp4", nil
	case bytes.HasPrefix(header, []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return "audio/webm", nil
	case bytes.HasPrefix(header, []byte("MAC ")):
		return "audio/ape", nil
	case n >= 2 && header[0] == 0xff && header[1]&0xf6 == 0xf0:
		return "audio/aac", nil
	case n >= 2 && header[0] == 0xff && header[1]&0xe0 == 0xe0:
		return "audio/mpeg", nil
	}
	if mime, supported := localAudioExtensions[strings.ToLower(filepath.Ext(file.Name()))]; supported {
		return mime, nil
	}
	return "", errLocalAudio
}
