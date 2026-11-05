package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestLinuxGraphicsPersistsAndPlansEachNextStartup(t *testing.T) {
	directory := t.TempDir()
	environment := []string{"PATH=/test/bin", "DISPLAY=:1"}
	second, next := prepareLinuxGraphicsCompatibility(t, directory, environment)
	if err := saveLinuxGraphics(directory, false); err != nil {
		t.Fatal(err)
	}
	normal, changed, err := second.prepare(directory, next)
	if err != nil || !changed || !reflect.DeepEqual(normal, environment) {
		t.Fatalf("could not turn compatibility off: %v %v", changed, err)
	}
	third := &LinuxGraphics{}
	if _, changed, err := third.prepare(directory, normal); err != nil || changed || third.snapshot().Applied || third.snapshot().Enabled {
		t.Fatalf("normal startup would loop: %v %v", changed, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(directory, linuxGraphicsFile))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatal("graphics preference is not private")
		}
	}
}

func prepareLinuxGraphicsCompatibility(t *testing.T, directory string, environment []string) (*LinuxGraphics, []string) {
	t.Helper()
	first := &LinuxGraphics{}
	if next, changed, err := first.prepare(directory, environment); err != nil || changed || !reflect.DeepEqual(next, environment) {
		t.Fatalf("unsaved startup changed environment: %v %v", changed, err)
	}
	if err := saveLinuxGraphics(directory, true); err != nil {
		t.Fatal(err)
	}
	if enabled, found, err := loadLinuxGraphics(directory); err != nil || !found || !enabled {
		t.Fatalf("did not persist compatibility: %v %v %v", enabled, found, err)
	}
	next, changed, err := first.prepare(directory, environment)
	if err != nil || !changed || !linuxGraphicsApplied(next) {
		t.Fatalf("did not plan a compatibility launch: %v %v", changed, err)
	}
	second := &LinuxGraphics{}
	if _, changed, err := second.prepare(directory, next); err != nil || changed || !second.snapshot().Applied || second.snapshot().RestartRequired {
		t.Fatalf("startup would loop or report wrong applied mode: %v %v", changed, err)
	}
	return second, next
}

func TestLinuxGraphicsRejectsDamagedFilesWithoutOverwriting(t *testing.T) {
	for _, data := range []string{
		`{}`, `{"version":1,"enabled":null}`, `{"version":2,"enabled":true}`,
		`{"version":1,"enabled":true,"extra":1}`, `{"version":1,"enabled":true,"enabled":false}`,
		`{"version":1,"enabled":"true"}`, `{"version":1,"enabled":true} {}`,
	} {
		t.Run(data, func(t *testing.T) {
			directory := t.TempDir()
			filename := filepath.Join(directory, linuxGraphicsFile)
			if err := os.WriteFile(filename, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			state := &LinuxGraphics{}
			environment := []string{"DISPLAY=:1"}
			if next, changed, err := state.prepare(directory, environment); err != nil || changed || !reflect.DeepEqual(next, environment) || !state.snapshot().LoadFailed {
				t.Fatalf("damaged settings were treated as authoritative: %v %v", changed, err)
			}
			actual, _ := os.ReadFile(filename)
			if string(actual) != data {
				t.Fatal("startup overwrote damaged preferences")
			}
		})
	}
}

func TestLinuxGraphicsPendingResetUsesNormalBeforeDeletion(t *testing.T) {
	directory := t.TempDir()
	if err := saveLinuxGraphics(directory, true); err != nil {
		t.Fatal(err)
	}
	if err := schedulePreferencesReset(directory, PreferencesResetSettings); err != nil {
		t.Fatal(err)
	}
	compatible, _ := linuxGraphicsLaunchEnvironment([]string{"DISPLAY=:1"}, true)
	state := &LinuxGraphics{}
	next, changed, err := state.prepare(directory, compatible)
	if err != nil || !changed || linuxGraphicsApplied(next) || state.snapshot().Enabled {
		t.Fatalf("reset retained the saved graphics mode: %v %v", changed, err)
	}
	if enabled, _, err := loadLinuxGraphics(directory); err != nil || !enabled {
		t.Fatal("bootstrap deleted preferences outside the singleton lock")
	}
	if err := completePreferencesReset(directory); err != nil {
		t.Fatal(err)
	}
	if _, found, err := loadLinuxGraphics(directory); err != nil || found {
		t.Fatal("settings reset did not remove the graphics preference")
	}
}

func TestLinuxGraphicsDiagnosticOverrideDoesNotChangeSavedChoice(t *testing.T) {
	directory := t.TempDir()
	if err := saveLinuxGraphics(directory, false); err != nil {
		t.Fatal(err)
	}
	state := &LinuxGraphics{}
	next, changed, err := state.prepare(directory, []string{"HE_MUSIC_GRAPHICS_MODE_OVERRIDE=software-gl", "DISPLAY=:1"})
	if err != nil || !changed || !linuxGraphicsApplied(next) || state.snapshot().Enabled {
		t.Fatal("diagnostic override was not scoped to this launch")
	}
	if enabled, _, err := loadLinuxGraphics(directory); err != nil || enabled {
		t.Fatal("diagnostic override changed persistent settings")
	}
}

func TestLinuxGraphicsWriteFailureDoesNotPublishDefault(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "not-directory")
	if err := os.WriteFile(directory, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := saveLinuxGraphics(directory, true); err == nil {
		t.Fatal("ignored a failed persistence operation")
	}
	data, _ := os.ReadFile(directory)
	if string(data) != "owned" {
		t.Fatal("failed save changed unrelated contents")
	}
}
