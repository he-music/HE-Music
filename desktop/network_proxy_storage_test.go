package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNetworkProxyTreeBoundsAndAmbiguity(t *testing.T) {
	for _, tc := range []struct {
		name     string
		children map[uintptr][]uintptr
		matches  map[uintptr]bool
		want     uintptr
	}{
		{"unique", map[uintptr][]uintptr{1: {2, 3}, 3: {4}}, map[uintptr]bool{4: true}, 4},
		{"absent", map[uintptr][]uintptr{1: {2}}, nil, 0},
		{"ambiguous", map[uintptr][]uintptr{1: {2, 3}}, map[uintptr]bool{2: true, 3: true}, 0},
		{"cycle", map[uintptr][]uintptr{1: {2}, 2: {1}}, map[uintptr]bool{2: true}, 0},
		{"oversized", map[uintptr][]uintptr{1: make([]uintptr, 257)}, map[uintptr]bool{1: true}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := findNetworkProxyWebview(1, func(id uintptr) (bool, []uintptr) { return tc.matches[id], tc.children[id] })
			if got != tc.want {
				t.Fatal(got, tc.want)
			}
		})
	}
	calls := 0
	got := findNetworkProxyWebview(1, func(id uintptr) (bool, []uintptr) { calls++; return id == 2, []uintptr{id + 1} })
	if got != 0 || calls > 33 {
		t.Fatal(got, calls)
	}
	calls = 0
	got = findNetworkProxyWebview(0, func(uintptr) (bool, []uintptr) { calls++; return true, nil })
	if got != 0 || calls != 0 {
		t.Fatal(got, calls)
	}
}

func TestNetworkProxyPersistenceTempDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "network-proxy.json")
	c, err := readNetworkProxyConfig(path)
	if err != nil || c.Protocol != "off" {
		t.Fatal(c, err)
	}
	c = NetworkProxyConfig{Protocol: "HTTP", Server: "Proxy.Invalid", Port: 8080}
	if err = saveNetworkProxyConfig(path, c); err != nil {
		t.Fatal(err)
	}
	got, err := readNetworkProxyConfig(path)
	if err != nil || got.Server != "proxy.invalid" {
		t.Fatal(got, err)
	}
	c.Protocol = "off"
	if err = saveNetworkProxyConfig(path, c); err != nil {
		t.Fatal(err)
	}
	got, err = readNetworkProxyConfig(path)
	if err != nil || got != (NetworkProxyConfig{Protocol: "off"}) {
		t.Fatal(got, err)
	}
	for _, data := range []string{"{", `{"protocol":"HTTP","server":"bad/path","port":8080}`, strings.Repeat(" ", 1025)} {
		if err = os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = readNetworkProxyConfig(path); err == nil {
			t.Fatal("invalid stored config accepted")
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatal(entries, err)
	}
}
