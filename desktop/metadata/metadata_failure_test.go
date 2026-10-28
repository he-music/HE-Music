package metadata

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMetadataV1OnlyArtists(t *testing.T) {
	path := fixture(t, "mp3", "3")
	b := mustRead(t, path)
	if len(b) < 10 || string(b[:3]) != "ID3" {
		t.Fatal("expected generated leading ID3 tag")
	}
	size := int(b[6])<<21 | int(b[7])<<14 | int(b[8])<<7 | int(b[9])
	footer := make([]byte, 128)
	copy(footer, "TAG")
	copy(footer[3:33], "legacy title")
	copy(footer[33:63], "legacy artist")
	copy(footer[63:93], "legacy album")
	legacy := append(append([]byte(nil), b[10+size:]...), footer...)
	work := filepath.Join(filepath.Dir(path), "v1-only.mp3")
	if err := os.WriteFile(work, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	packets := packetHash(t, work)
	artists := []string{"first", "second"}
	edit(t, work, Patch{Artists: &artists})
	info := readInfo(t, work, false)
	if !reflect.DeepEqual(info.Artists, artists) || info.Title != "legacy title" || info.Album != "legacy album" {
		t.Fatalf("v1 promotion lost metadata: %+v", info)
	}
	if !bytes.Equal(packets, packetHash(t, work)) {
		t.Fatal("v1 promotion changed audio packet payload")
	}
}

type failingCopy struct {
	*os.File
	writes int
}

var errInjectedWrite = errors.New("injected working copy write failure")

func (f *failingCopy) WriteAt(p []byte, offset int64) (int, error) {
	f.writes++
	return 0, errInjectedWrite
}

func TestMetadataWriteFailure(t *testing.T) {
	original := fixture(t, "mp3", "4")
	before := mustRead(t, original)
	work := filepath.Join(filepath.Dir(original), "failed-copy.mp3")
	if err := os.WriteFile(work, before, 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(work, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	src := &failingCopy{File: f}
	title := "changed"
	err = EditWorkingCopy(context.Background(), src, int64(len(before)), Patch{Title: &title})
	if err == nil || src.writes == 0 {
		t.Fatalf("injected failure must propagate, got %v after %d writes", err, src.writes)
	}
	if !bytes.Equal(before, mustRead(t, original)) {
		t.Fatal("failed copy edit changed original fixture")
	}
}
