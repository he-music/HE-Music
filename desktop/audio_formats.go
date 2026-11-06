package main

import (
	"path/filepath"
	"strings"
)

var localAudioExtensions = map[string]string{
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
	".aac": "audio/aac", ".webm": "audio/webm", ".m4a": "audio/mp4",
	".mp4": "audio/mp4", ".ogg": "audio/ogg", ".aiff": "audio/aiff",
	".aif": "audio/aiff", ".ape": "audio/ape",
	".dff": "audio/dff",
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
