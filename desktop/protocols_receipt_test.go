package main

import (
	"context"
	"testing"
)

type protocolReasonFailure struct{}

func (protocolReasonFailure) Error() string                      { return "bundle URL scheme declaration missing" }
func (protocolReasonFailure) ProtocolRegistrationReason() string { return "missing-declaration" }

type protocolReasonBackend struct{ calls int }

func (b *protocolReasonBackend) RegisterURLScheme(string) error {
	b.calls++
	return protocolReasonFailure{}
}
func (b *protocolReasonBackend) UnregisterURLScheme(string) error {
	panic("macOS must not unregister on disable")
}
func (b *protocolReasonBackend) IsURLSchemeRegistered(string) bool { return true }

func TestProtocolDisableRetainsAssociationWithoutFailure(t *testing.T) {
	backend := &protocolReasonBackend{}
	state := protocolState{backend: backend, goos: "darwin"}
	ctx := context.Background()
	epoch, err := state.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	status, _, err := state.sync(ctx, epoch, nil)
	if err != nil || backend.calls != 0 {
		t.Fatal(status, err)
	}
	for _, result := range status.Results {
		if result.Selected || !result.Registered || result.Status != "disabled" || result.Reason != "" {
			t.Fatal("disabled processing was confused with system association failure", result)
		}
	}
	state.receive(orpheusFixture(`{"type":"song","id":"123","cmd":"play"}`))
	if events := state.drain(); len(events) != 0 {
		t.Fatal("disabled protocol played", events)
	}
	status, _, err = state.sync(ctx, status.Epoch, []string{"orpheus"})
	if err != nil || status.Results[0].Status != "registration-failed" || status.Results[0].Reason != "missing-declaration" || state.enabled["orpheus"] {
		t.Fatal("registration error was hidden or enabled playback", status, err)
	}
}
