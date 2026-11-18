package main

import "testing"

const kuwoOfficialSongURL = "kuwo://play/?play=MQ==&num=MQ==&musicrid0=TVVTSUNfMzQ1MzcyNw==&name0=sLK6zcfF&artist0=y862rNKw&album0=sLK6zcfFsbE=&artistid0=OTczMDU=&albumid0=Mjc1MzA3&playsource=d2ViwK3G8L/Nu6e2yy0+MjAxNrDmtaXH+tKz"

func TestProtocolKuwoOfficialSong(t *testing.T) {
	for _, raw := range []string{
		kuwoOfficialSongURL,
		"kuwo://play/?musicrid0=TVVTSUNfMzQ1MzcyNw==",
		"kuwo://play?musicrid0=TVVTSUNfMzQ1MzcyNw==&name0=ignored&playsource=ignored",
	} {
		intent, ok := parseProtocolURL(raw)
		if !ok || intent.Platform != "kuwo" || intent.SongID != "3453727" {
			t.Fatalf("official song link rejected: intent=%+v, ok=%t", intent, ok)
		}
	}
}

func TestProtocolKuwoOfficialSongDelivery(t *testing.T) {
	ctx := t.Context()
	state := protocolState{backend: &protocolFake{registered: map[string]bool{}}}
	state.receive(kuwoOfficialSongURL)
	epoch, err := state.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	status, initial, err := state.sync(ctx, epoch, []string{"kuwo"})
	if err != nil || len(initial) != 1 {
		t.Fatalf("startup song link not delivered: events=%+v, err=%v", initial, err)
	}
	state.receive(kuwoOfficialSongURL)
	repeated := state.drain()
	if len(repeated) != 1 || repeated[0].SongID != "3453727" || repeated[0].Sequence <= initial[0].Sequence {
		t.Fatalf("running app song link not delivered: %+v", repeated)
	}
	if _, _, err := state.sync(ctx, status.Epoch, nil); err != nil {
		t.Fatal(err)
	}
	state.receive(kuwoOfficialSongURL)
	if len(state.drain()) != 0 {
		t.Fatal("disabled protocol delivered a song link")
	}
}
