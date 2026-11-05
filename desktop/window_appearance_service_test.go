package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowAppearanceServiceUsesSavedSettingsOnlyAtStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appearance.json")
	service := &WindowAppearanceService{}
	initial, err := service.initialize(path)
	if err != nil || initial.UseBorderless {
		t.Fatalf("initial=%+v err=%v", initial, err)
	}
	pending, err := service.save(true)
	if err != nil || !pending.UseBorderless || pending.AppliedUseBorderless || !pending.RestartRequired {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
	next := &WindowAppearanceService{}
	appearance, err := next.initialize(path)
	if err != nil || !appearance.UseBorderless || !next.snapshot().AppliedUseBorderless || next.snapshot().RestartRequired {
		t.Fatalf("next=%+v err=%v", next.snapshot(), err)
	}
	restored, err := service.save(false)
	if err != nil || restored.UseBorderless || restored.AppliedUseBorderless || restored.RestartRequired {
		t.Fatalf("restored=%+v err=%v", restored, err)
	}
}

func TestWindowAppearanceServiceRejectsDuplicateFieldsAndCanRecover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appearance.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"useBorderless":true,"useBorderless":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &WindowAppearanceService{}
	initial, err := service.initialize(path)
	if err == nil || initial.UseBorderless || !service.snapshot().LoadFailed {
		t.Fatal("ambiguous config was applied", service.snapshot(), err)
	}
	saved, err := service.save(true)
	if err != nil || saved.LoadFailed || !saved.RestartRequired {
		t.Fatal(saved, err)
	}
	before := service.snapshot()
	service.store.path = t.TempDir() // Rename over a directory cannot commit a setting.
	if _, err := service.save(false); err == nil || service.snapshot() != before {
		t.Fatal("failed save changed state", service.snapshot(), err)
	}
}
