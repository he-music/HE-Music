package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type failingSettingsOutput struct {
	file    *os.File
	failure string
	closed  int
	synced  int
}

func (out *failingSettingsOutput) Write(data []byte) (int, error) {
	if out.failure == "write" {
		return 0, errors.New("synthetic private write error")
	}
	if out.failure == "short" {
		return out.file.Write(data[:len(data)-1])
	}
	return out.file.Write(data)
}
func (out *failingSettingsOutput) Sync() error {
	out.synced++
	if out.failure == "sync" {
		return errors.New("synthetic private sync error")
	}
	return out.file.Sync()
}
func (out *failingSettingsOutput) Close() error {
	out.closed++
	err := out.file.Close()
	if out.failure == "close" {
		return errors.New("synthetic private close error")
	}
	return err
}

func TestSettingsOutputFailurePreservesOriginalAndCleansTemp(t *testing.T) {
	for _, failure := range []string{"write", "short", "sync", "close"} {
		t.Run(failure, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			original := []byte(`{"original":true}`)
			writeFileTestSettings(t, path, original)
			parent, err := openDirectoryHandle(dir)
			if err != nil {
				t.Fatal(err)
			}
			save := &preparedSettingsSave{parent: parent, name: "settings.json", temp: ".he-music-settings-failure.tmp"}
			file, err := parent.root.OpenFile(save.temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				parent.root.Close()
				t.Fatal(err)
			}
			output := &failingSettingsOutput{file: file, failure: failure}
			if err := writeSettingsOutput(output, []byte(`{"replacement":true}`)); err != errFileIO {
				t.Fatal("write failure not sanitized")
			}
			if output.closed != 1 {
				t.Fatal("output not closed exactly once")
			}
			if (failure == "write" || failure == "short") && output.synced != 0 {
				t.Fatal("failed write was synced")
			}
			save.cleanup()
			actual, err := os.ReadFile(path)
			if err != nil || string(actual) != string(original) {
				t.Fatal("failed temporary write changed original")
			}
			assertNoSettingsTemp(t, dir)
		})
	}
}
