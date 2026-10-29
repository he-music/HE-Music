package main

import (
	"context"
	"fmt"
	"testing"
)

func TestProtocolRepeatAfterDelivery(t *testing.T) {
	for _, raw := range []string{orpheusFixture(`{"type":"song","id":"123","cmd":"play"}`), "kuwo://play?musicrid0=TVVTSUNfMTIz"} {
		state := protocolState{backend: &protocolFake{registered: map[string]bool{}}}
		state.receive(raw)
		state.receive(raw)
		epoch, err := state.begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		_, initial, err := state.sync(context.Background(), epoch, []string{"orpheus", "kuwo"})
		if err != nil || len(initial) != 1 {
			t.Fatal("startup duplicates must be merged")
		}
		state.receive(raw)
		state.receive(raw)
		repeated := state.drain()
		if len(repeated) != 1 {
			t.Fatal("delivered song must be accepted again, merging only pending duplicates")
		}
		if repeated[0].Sequence <= initial[0].Sequence {
			t.Fatal("repeat needs a fresh sequence")
		}
	}
}

func TestProtocolContinuesAfterManyDeliveries(t *testing.T) {
	state := protocolState{backend: &protocolFake{registered: map[string]bool{}}}
	ctx := context.Background()
	epoch, err := state.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = state.sync(ctx, epoch, []string{"orpheus"}); err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 1100; id++ {
		raw := orpheusFixture(fmt.Sprintf(`{"type":"song","id":"%d","cmd":"play"}`, id))
		state.receive(raw)
		if events := state.drain(); len(events) != 1 {
			t.Fatalf("delivery %d was permanently disabled", id)
		}
		if len(state.pending) != 0 {
			t.Fatal("delivered entries retained")
		}
	}
}

func TestProtocolOverflowRecoversAfterDrain(t *testing.T) {
	state := protocolState{backend: &protocolFake{registered: map[string]bool{}}}
	for id := 1; id <= protocolQueueLimit+1; id++ {
		state.receive(orpheusFixture(fmt.Sprintf(`{"type":"song","id":"%d","cmd":"play"}`, id)))
	}
	if len(state.pending) != protocolQueueLimit {
		t.Fatal("pending queue not bounded")
	}
	ctx := context.Background()
	epoch, err := state.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, events, err := state.sync(ctx, epoch, []string{"orpheus"})
	if err != nil || len(events) != protocolQueueLimit {
		t.Fatal("bounded queue failed to drain")
	}
	state.receive(orpheusFixture(fmt.Sprintf(`{"type":"song","id":"%d","cmd":"play"}`, protocolQueueLimit+1)))
	if len(state.drain()) != 1 {
		t.Fatal("overflow permanently blocked a later valid link")
	}
}
