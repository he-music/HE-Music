package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/png"
	"strings"
	"unicode"

	"github.com/egoist/mygo"
)

type LyricCardSaveStatus string

const (
	LyricCardSaved     LyricCardSaveStatus = "saved"
	LyricCardCancelled LyricCardSaveStatus = "cancelled"
	lyricCardMaxBytes                      = 16 << 20
)

var errLyricCard = errors.New("lyric card save failed")

// SaveLyricCard writes PNG bytes only to a path selected in the native dialog.
func (f *NativeFiles) SaveLyricCard(ctx context.Context, epoch uint64, suggestedName, payload string) (LyricCardSaveStatus, error) {
	return f.state.saveLyricCard(ctx, epoch, suggestedName, payload)
}

func (s *nativeFilesState) saveLyricCard(ctx context.Context, epoch uint64, suggestedName, payload string) (LyricCardSaveStatus, error) {
	op, err := s.begin(ctx, epoch)
	if err != nil {
		return "", err
	}
	defer s.finish(op)

	if len(payload) > base64.StdEncoding.EncodedLen(lyricCardMaxBytes) {
		return "", errLyricCard
	}
	data, err := base64.StdEncoding.Strict().DecodeString(payload)
	if err != nil || len(data) > lyricCardMaxBytes {
		return "", errLyricCard
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 960 || config.Height < 1 || config.Height > 4096 {
		return "", errLyricCard
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return "", errLyricCard
	}
	if err := s.check(op); err != nil {
		return "", err
	}
	if !validLyricCardName(suggestedName) {
		suggestedName = "HE-Music.png"
	}
	path, pickerErr := s.picker.Save(mygo.SaveDialogOptions{
		Parent: op.parent, DefaultPath: suggestedName, CreateDirectories: true,
		Filters: []mygo.FileFilter{{Name: "PNG", Extensions: []string{"png"}}},
	})
	if err := s.check(op); err != nil {
		return "", err
	}
	if pickerErr != nil {
		return "", errFilesPicker
	}
	if path == "" {
		return LyricCardCancelled, nil
	}
	save, err := prepareFileSave(path, data, ".png", ".he-music-lyric-card-")
	if err != nil {
		return "", errLyricCard
	}
	defer save.cleanup()
	if err := s.claimCommit(op); err != nil {
		return "", err
	}
	if err := save.replace(); err != nil {
		return "", errLyricCard
	}
	if err := s.check(op); err != nil {
		return "", err
	}
	return LyricCardSaved, nil
}

func validLyricCardName(name string) bool {
	return len(name) <= 256 && (name == "HE-Music.png" || strings.HasPrefix(name, "HE-Music - ")) &&
		strings.HasSuffix(name, ".png") && !strings.ContainsAny(name, "/\\:*?\"<>|") &&
		strings.IndexFunc(name, unicode.IsControl) == -1
}
