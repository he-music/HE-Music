//go:build darwin

package main

import (
	"errors"
	"os"
	"testing"
)

// This models only the Foundation messages used by the production validator;
// it never loads a framework or calls Launch Services.
type protocolBundleObject struct {
	class string
	text  string
	props map[string]uintptr
	items []uintptr
}

func TestProtocolBundleBridgeValidation(t *testing.T) {
	for _, scenario := range []string{"valid", "bare", "no-id", "wrong-package", "no-app", "nonfile", "wrong-url-type", "wrong-types", "wrong-entry", "wrong-schemes", "undeclared", "ls-error"} {
		t.Run(scenario, func(t *testing.T) {
			b := newProtocolTestBundle(scenario)
			registrations, sdkCalls := 0, 0
			b.register = func(url uintptr, update bool) int32 {
				if url != 2 || !update {
					t.Fatal("must register the current bundle URL with update=true")
				}
				registrations++
				if scenario == "ls-error" {
					return -10811
				}
				return 0
			}
			err := b.withBundle("kuwo", func(register func() error) error {
				if err := register(); err != nil {
					return err
				}
				sdkCalls++
				return nil
			})
			if scenario == "valid" {
				if err != nil || registrations != 1 || sdkCalls != 1 {
					t.Fatalf("valid bundle: %v, %d, %d", err, registrations, sdkCalls)
				}
				return
			}
			var diagnostic interface{ ProtocolRegistrationReason() string }
			wantReason := "missing-declaration"
			wantRegistrations := 0
			if scenario == "ls-error" {
				wantReason, wantRegistrations = "bundle-registration-failed", 1
			}
			if !errors.As(err, &diagnostic) || diagnostic.ProtocolRegistrationReason() != wantReason || registrations != wantRegistrations || sdkCalls != 0 {
				t.Fatalf("invalid bundle: %v, %d, %d", err, registrations, sdkCalls)
			}
		})
	}
}

func TestNativeProtocolGenerationNoOS(t *testing.T) {
	t.Setenv("MYGO_GENERATE", "1")
	if os.Getenv("MYGO_GENERATE") == "" {
		t.Fatal("generation guard not installed")
	}
	b := newNativeProtocolBackend()
	if !errors.Is(b.RegisterURLScheme("orpheus"), errNativeProtocolUnavailable) ||
		!errors.Is(b.UnregisterURLScheme("kuwo"), errNativeProtocolUnavailable) || b.IsURLSchemeRegistered("kuwo") {
		t.Fatal("generation touched native backend")
	}
}
