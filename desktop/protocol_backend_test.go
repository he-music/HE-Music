package main

import (
	"errors"
	"reflect"
	"testing"
)

type protocolBackendSDKFake struct {
	calls      *[]string
	setErr     error
	unsetErr   error
	registered bool
}

func (f *protocolBackendSDKFake) RegisterURLScheme(s string) error {
	*f.calls = append(*f.calls, "sdk-set:"+s)
	return f.setErr
}

func (f *protocolBackendSDKFake) UnregisterURLScheme(s string) error {
	*f.calls = append(*f.calls, "sdk-unset:"+s)
	return f.unsetErr
}

func (f *protocolBackendSDKFake) IsURLSchemeRegistered(s string) bool {
	*f.calls = append(*f.calls, "sdk-read:"+s)
	return f.registered
}

type protocolBackendFixture struct {
	calls     []string
	available bool
	bundleErr error
	lsErr     error
	sdk       *protocolBackendSDKFake
	backend   *nativeProtocolBackend
}

func newProtocolBackendFixture() *protocolBackendFixture {
	f := &protocolBackendFixture{available: true}
	f.sdk = &protocolBackendSDKFake{calls: &f.calls, registered: true}
	f.backend = &nativeProtocolBackend{
		sdk:       f.sdk,
		available: func() bool { return f.available },
		onMain: func(fn func()) {
			f.calls = append(f.calls, "main")
			fn()
		},
		withBundle: func(scheme string, fn func(func() error) error) error {
			f.calls = append(f.calls, "current-bundle:"+scheme)
			if f.bundleErr != nil {
				return f.bundleErr
			}
			f.calls = append(f.calls, "declared:"+scheme)
			return fn(func() error {
				f.calls = append(f.calls, "ls-register")
				return f.lsErr
			})
		},
	}
	return f
}

func TestNativeProtocolBackendOrderAndBoundedCache(t *testing.T) {
	f := newProtocolBackendFixture()
	for _, scheme := range []string{"orpheus", "kuwo", "orpheus"} {
		if err := f.backend.RegisterURLScheme(scheme); err != nil {
			t.Fatal(err)
		}
		if !f.backend.IsURLSchemeRegistered(scheme) {
			t.Fatal("readback lost")
		}
	}
	want := []string{
		"main", "current-bundle:orpheus", "declared:orpheus", "ls-register", "sdk-set:orpheus", "main", "sdk-read:orpheus",
		"main", "current-bundle:kuwo", "declared:kuwo", "sdk-set:kuwo", "main", "sdk-read:kuwo",
		"main", "current-bundle:orpheus", "declared:orpheus", "sdk-set:orpheus", "main", "sdk-read:orpheus",
	}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls = %v", f.calls)
	}
	// Even after success, each selected scheme must pass declaration validation.
	f.bundleErr = &protocolRegistrationError{"missing-declaration", errors.New("missing scheme")}
	f.calls = nil
	if err := f.backend.RegisterURLScheme("kuwo"); !errors.Is(err, f.bundleErr) {
		t.Fatalf("cached validation bypass: %v", err)
	}
	if !reflect.DeepEqual(f.calls, []string{"main", "current-bundle:kuwo"}) {
		t.Fatal(f.calls)
	}
}

func TestNativeProtocolBackendFailureAndRetry(t *testing.T) {
	for _, phase := range []string{"declaration", "ls", "sdk"} {
		t.Run(phase, func(t *testing.T) {
			f := newProtocolBackendFixture()
			failure := errors.New("failure")
			switch phase {
			case "declaration":
				f.bundleErr = failure
			case "ls":
				f.lsErr = failure
			case "sdk":
				f.sdk.setErr = failure
			}
			if err := f.backend.RegisterURLScheme("orpheus"); !errors.Is(err, failure) {
				t.Fatalf("failure hidden: %v", err)
			}
			if phase != "sdk" && f.backend.bundleRegistered {
				t.Fatal("failed bundle registration was cached")
			}
			for _, call := range f.calls {
				if phase != "sdk" && call == "sdk-set:orpheus" {
					t.Fatal("SDK called before bundle validation/registration succeeded")
				}
			}
			f.bundleErr, f.lsErr, f.sdk.setErr = nil, nil, nil
			f.calls = nil
			if err := f.backend.RegisterURLScheme("orpheus"); err != nil {
				t.Fatal(err)
			}
			want := []string{"main", "current-bundle:orpheus", "declared:orpheus"}
			if phase != "sdk" {
				want = append(want, "ls-register")
			}
			want = append(want, "sdk-set:orpheus")
			if !reflect.DeepEqual(f.calls, want) {
				t.Fatal(f.calls)
			}
		})
	}
}

func TestNativeProtocolBackendGuardsAndSDKSemantics(t *testing.T) {
	f := newProtocolBackendFixture()
	for _, scheme := range []string{"", "other", "ORPHEUS", "orpheus://private"} {
		if f.backend.RegisterURLScheme(scheme) == nil || f.backend.UnregisterURLScheme(scheme) == nil || f.backend.IsURLSchemeRegistered(scheme) {
			t.Fatal("invalid scheme accepted")
		}
	}
	f.available = false
	if !errors.Is(f.backend.RegisterURLScheme("kuwo"), errNativeProtocolUnavailable) ||
		!errors.Is(f.backend.UnregisterURLScheme("kuwo"), errNativeProtocolUnavailable) ||
		f.backend.IsURLSchemeRegistered("kuwo") || len(f.calls) != 0 {
		t.Fatal("unavailable backend touched native hooks")
	}
	f.available = true
	f.sdk.registered = false
	if f.backend.IsURLSchemeRegistered("kuwo") {
		t.Fatal("readback fabricated")
	}
	unsupported := errors.New("unsupported")
	f.sdk.unsetErr = unsupported
	if err := f.backend.UnregisterURLScheme("kuwo"); !errors.Is(err, unsupported) {
		t.Fatalf("unregister semantic changed: %v", err)
	}
	if !reflect.DeepEqual(f.calls, []string{"main", "sdk-read:kuwo", "main", "sdk-unset:kuwo"}) {
		t.Fatal(f.calls)
	}
}

func TestNativeProtocolBackendDroppedMainCallback(t *testing.T) {
	f := newProtocolBackendFixture()
	f.backend.onMain = func(func()) {}
	if !errors.Is(f.backend.RegisterURLScheme("kuwo"), errNativeProtocolUnavailable) ||
		!errors.Is(f.backend.UnregisterURLScheme("kuwo"), errNativeProtocolUnavailable) ||
		f.backend.IsURLSchemeRegistered("kuwo") {
		t.Fatal("dropped callback reported success")
	}
}

func TestProtocolRegistrationReason(t *testing.T) {
	for _, code := range []string{"missing-declaration", "bundle-registration-failed"} {
		cause := errors.New("native failure")
		err := &protocolRegistrationError{code, cause}
		var diagnostic interface{ ProtocolRegistrationReason() string }
		if !errors.As(err, &diagnostic) || diagnostic.ProtocolRegistrationReason() != code || !errors.Is(err, cause) {
			t.Fatal("diagnostic contract lost")
		}
	}
}
