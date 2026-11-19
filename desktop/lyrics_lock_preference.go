package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
)

const lyricsLockPreferenceFile = "desktop-lyrics-locked.json"

func (l *DesktopLyrics) loadLockPreference(directory string) error {
	l.lockPreferencePath = filepath.Join(directory, lyricsLockPreferenceFile)
	l.preferredLocked = false
	info, err := os.Lstat(l.lockPreferencePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() < 4 || info.Size() > 5 {
		return errors.New("invalid desktop lyrics lock preference")
	}
	data, err := os.ReadFile(l.lockPreferencePath)
	if err != nil {
		return err
	}
	switch string(data) {
	case "true":
		l.preferredLocked = true
	case "false":
	default:
		return errors.New("invalid desktop lyrics lock preference")
	}
	return nil
}

func (l *DesktopLyrics) rememberLock(locked bool) {
	l.preferredLocked = locked
	if l.lockPreferencePath != "" {
		if err := saveLyricsLockPreference(l.lockPreferencePath, locked); err != nil {
			log.Print("保存桌面歌词锁定偏好失败: ", err)
		}
	}
}

func saveLyricsLockPreference(path string, locked bool) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".desktop-lyrics-lock-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := writeSettingsOutput(file, []byte(strconv.FormatBool(locked))); err != nil {
		return err
	}
	return commitPreferencesResetRename(file.Name(), path)
}
