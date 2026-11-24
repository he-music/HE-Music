package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func lyricCardTestPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 960, 128))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestLyricCardUsesNativePickerAndWritesSelectedPNG(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	path := filepath.Join(t.TempDir(), "自选位置.png")
	data := lyricCardTestPNG(t)
	payload := base64.StdEncoding.EncodeToString(data)
	actor.state.picker = fakeFilePicker{save: func(options mygo.SaveDialogOptions) (string, error) {
		if options.Parent != actor.parent || options.DefaultPath != "HE-Music - 歌曲.png" ||
			len(options.Filters) != 1 || len(options.Filters[0].Extensions) != 1 || options.Filters[0].Extensions[0] != "png" {
			t.Fatalf("unexpected save options: %+v", options)
		}
		return path, nil
	}}
	status, err := actor.state.saveLyricCard(ctx, epoch, "HE-Music - 歌曲.png", payload)
	if err != nil || status != LyricCardSaved {
		t.Fatalf("save = %q, %v", status, err)
	}
	if saved, err := os.ReadFile(path); err != nil || !bytes.Equal(saved, data) {
		t.Fatalf("selected file wasn't written: %v", err)
	}
}

func TestLyricCardCancellationAndStalePickerNeverWrite(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	path := filepath.Join(t.TempDir(), "card.png")
	payload := base64.StdEncoding.EncodeToString(lyricCardTestPNG(t))
	actor.state.picker = fakeFilePicker{save: func(options mygo.SaveDialogOptions) (string, error) {
		if options.DefaultPath != "HE-Music.png" {
			t.Fatalf("unsafe suggested name reached picker: %q", options.DefaultPath)
		}
		return "", nil
	}}
	if status, err := actor.state.saveLyricCard(ctx, epoch, "../outside.png", payload); err != nil || status != LyricCardCancelled {
		t.Fatalf("cancel = %q, %v", status, err)
	}
	actor.state.picker = fakeFilePicker{save: func(mygo.SaveDialogOptions) (string, error) {
		actor.state.dispatch(actor.state.revoke)
		return path, nil
	}}
	if _, err := actor.state.saveLyricCard(ctx, epoch, "HE-Music.png", payload); !errors.Is(err, errFilesOwner) {
		t.Fatalf("stale picker = %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale picker wrote to disk: %v", err)
	}
}

func TestLyricCardRejectsMalformedImageBeforeOpeningPicker(t *testing.T) {
	actor, ctx, epoch := newFileTestActor(t)
	actor.state.picker = fakeFilePicker{save: func(mygo.SaveDialogOptions) (string, error) {
		t.Fatal("invalid PNG reached picker")
		return "", nil
	}}
	data := lyricCardTestPNG(t)
	for _, payload := range []string{"invalid", base64.StdEncoding.EncodeToString(data[:len(data)/2])} {
		if _, err := actor.state.saveLyricCard(ctx, epoch, "HE-Music.png", payload); !errors.Is(err, errLyricCard) {
			t.Fatalf("malformed image = %v", err)
		}
	}
}
