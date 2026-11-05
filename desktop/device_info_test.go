package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeviceModelLabelsAreBoundedAndDoNotNeedShellCommands(t *testing.T) {
	for _, test := range []struct{ input, expected string }{
		{"Mac14,2\x00", "Mac14,2"},
		{"  Notebook  ", "Notebook"},
		{"", "Desktop"},
		{"System Product Name", "Desktop"},
		{"To Be Filled By O.E.M.", "Desktop"},
		{"bad\nmodel", "Desktop"},
		{strings.Repeat("a", 257), "Desktop"},
	} {
		if got := normalizeDeviceModel(test.input, "Desktop"); got != test.expected {
			t.Fatalf("model=%q want=%q", got, test.expected)
		}
	}
	path := filepath.Join(t.TempDir(), "model")
	if err := os.WriteFile(path, []byte(strings.Repeat("a", 2048)), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readDeviceModelFile(path); len(got) != 257 || normalizeDeviceModel(got, "Desktop") != "Desktop" {
		t.Fatalf("unbounded model: %d", len(got))
	}
	if got := readDeviceModelFile(path + "-missing"); got != "" {
		t.Fatal(got)
	}
}
