package main

import (
	"context"
	"errors"
	"testing"
)

func TestUpdatesSDKGenerateIsUnavailableWithoutProbing(t *testing.T) {
	// This path exits before IsDev/Enabled/Check, so no real SDK installation
	// directory probe, network fetch, AppData read, or install is performed.
	t.Setenv("MYGO_GENERATE", "1")
	candidate, err := (updatesSDKDriver{}).check(context.Background())
	if candidate != nil || !errors.Is(err, errUpdatesUnavailable) {
		t.Fatalf("generation incorrectly offered updates: candidate=%v err=%v", candidate, err)
	}
}
