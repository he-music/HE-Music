//go:build linux

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

// Exercise the real startup replacement with the same executable and PID, then
// inspect libc's environment before creating any GTK or WebKit object.
func TestLinuxGraphicsInitialCEnvironment(t *testing.T) {
	const helper = "HE_MUSIC_GRAPHICS_BOOTSTRAP_TEST_DIRECTORY"
	type observation struct {
		PID    int               `json:"pid"`
		Values map[string]string `json:"values"`
	}
	if directory := os.Getenv(helper); directory != "" {
		mygo.App.SetPath(mygo.PathUserData, directory)
		if err := bootstrapLinuxGraphics(); err != nil {
			t.Fatal(err)
		}
		library, err := purego.Dlopen("libc.so.6", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			t.Fatal(err)
		}
		var getenv func(string) string
		purego.RegisterLibFunc(&getenv, library, "getenv")
		values := map[string]string{}
		for _, flag := range linuxGraphicsEnvironment {
			values[flag.key] = getenv(flag.key)
		}
		if err := json.NewEncoder(os.Stdout).Encode(observation{os.Getpid(), values}); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	for _, enabled := range []bool{true, false} {
		directory := t.TempDir()
		if err := saveLinuxGraphics(directory, enabled); err != nil {
			t.Fatal(err)
		}
		environment, _ := linuxGraphicsLaunchEnvironment(os.Environ(), !enabled)
		filtered := make([]string, 0, len(environment)+1)
		for _, entry := range environment {
			if !strings.HasPrefix(entry, "MYGO_GENERATE=") && !strings.HasPrefix(entry, "HE_MUSIC_GRAPHICS_MODE_OVERRIDE=") {
				filtered = append(filtered, entry)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLinuxGraphicsInitialCEnvironment$")
		command.Env = append(filtered, helper+"="+directory)
		output, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("startup failed: %v: %s", err, output)
		}
		var result observation
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("invalid startup observation: %v: %s", err, output)
		}
		if result.PID != command.Process.Pid {
			t.Fatal("bootstrap did not replace the original process")
		}
		for _, flag := range linuxGraphicsEnvironment {
			want := ""
			if enabled {
				want = flag.value
			}
			if result.Values[flag.key] != want {
				t.Errorf("libc %s=%q, want %q", flag.key, result.Values[flag.key], want)
			}
		}
	}
}
