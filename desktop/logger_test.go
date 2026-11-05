package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDailyLogWriterRotatesBySizeAndDateAndPrunesOnlyOwnedFiles(t *testing.T) {
	directory := t.TempDir()
	writer, err := newDailyLogWriter(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	clock := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	writer.now = func() time.Time { return clock }
	writer.maxSize = 12
	for _, value := range []string{"first\n", "other\n", "third\n"} {
		if n, err := writer.Write([]byte(value)); err != nil || n != len(value) {
			t.Fatal(n, err)
		}
	}
	previous, err := os.ReadFile(filepath.Join(directory, "2026-11-01.previous.log"))
	if err != nil || string(previous) != "first\nother\n" {
		t.Fatal(string(previous), err)
	}
	current, err := os.ReadFile(filepath.Join(directory, "2026-11-01.log"))
	if err != nil || string(current) != "third\n" {
		t.Fatal(string(current), err)
	}
	info, err := os.Stat(filepath.Join(directory, "2026-11-01.log"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal(info, err)
	}
	if err := os.WriteFile(filepath.Join(directory, "unrelated.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	clock = clock.AddDate(0, 0, 16)
	if _, err := writer.Write([]byte("new day\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, "2026-11-01.log")); !os.IsNotExist(err) {
		t.Fatal("expired log retained")
	}
	if _, err := os.Stat(filepath.Join(directory, "unrelated.txt")); err != nil {
		t.Fatal("unrelated file removed")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal("close is not idempotent", err)
	}
	if _, err := writer.Write([]byte("late")); !os.IsNotExist(err) && err != os.ErrClosed {
		t.Fatal("closed writer accepted data", err)
	}
}

func TestLogRedactionAndMultilineBoundary(t *testing.T) {
	input := "request https://user:SECRET@api.test/path?token=SECRET token=SECRET password=SECRET\nAuthorization: Bearer SECRET"
	output := safeLogMessage(input)
	if strings.Contains(output, "SECRET") || strings.Contains(output, "\n") || strings.Contains(output, "user:") {
		t.Fatal(output)
	}
	if !strings.Contains(output, "https://api.test/…") || !strings.Contains(output, "[redacted]") {
		t.Fatal(output)
	}
}
