package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLyricsLockPreferencePersistsAcrossInstances(t *testing.T) {
	directory := t.TempDir()
	lyrics := &DesktopLyrics{}
	requireTestNoError(t, lyrics.loadLockPreference(directory))
	requireTestEqual(t, lyrics.preferredLocked, false)

	for _, locked := range []bool{true, false} {
		lyrics.rememberLock(locked)
		lyrics = &DesktopLyrics{}
		requireTestNoError(t, lyrics.loadLockPreference(directory))
		requireTestEqual(t, lyrics.preferredLocked, locked)
		requireTestEqual(t, lyrics.state.window.Locked, false)
	}
}

func TestLyricsLockPreferenceInvalidDataDefaultsToUnlocked(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, lyricsLockPreferenceFile)
	requireTestNoError(t, os.WriteFile(path, []byte("null"), 0o600))
	lyrics := &DesktopLyrics{preferredLocked: true}
	if err := lyrics.loadLockPreference(directory); err == nil {
		t.Fatal("invalid lock preference accepted")
	}
	requireTestEqual(t, lyrics.preferredLocked, false)
}
