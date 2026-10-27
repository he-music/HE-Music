package main

import (
	"context"
	"encoding/base64"
	"reflect"
	"testing"

	"github.com/egoist/mygo"
)

// Cancellation can happen outside the serialized main-thread lifecycle while
// decoding a cover. This backend cancels at the last read before publication.
type cancellingArtworkSystemMedia struct {
	*fakeSystemMedia
	cancel context.CancelFunc
}

func (f *cancellingArtworkSystemMedia) Info() (mygo.NowPlayingInfo, bool) {
	info, showing := f.fakeSystemMedia.Info()
	f.cancel()
	return info, showing
}

func TestSystemMediaArtworkCancellationDuringInfoCannotPublish(t *testing.T) {
	s, media, power, original, gen := newSystemMediaArtworkTest(t)
	ctx, cancel := context.WithCancel(original)
	defer cancel()
	s.owner = ctx
	s.media = &cancellingArtworkSystemMedia{fakeSystemMedia: media, cancel: cancel}
	before := media.info
	sets := len(media.sets)
	encoded := base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "png", 2, 2))
	if err := s.artwork(ctx, gen, 1, s.trackID, encoded); err == nil {
		t.Fatal("context cancelled during Info still published artwork")
	}
	if media.infoReads != 1 || len(media.sets) != sets || !reflect.DeepEqual(media.info, before) {
		t.Fatal("cancelled artwork changed the current snapshot")
	}
	if len(media.callbacks) != 1 || media.offs != 0 || power.next != 1 || power.releases != 0 {
		t.Fatal("cancelled artwork changed subscriptions or power leases")
	}
	s.revoke()
	if err := s.artwork(ctx, gen, 1, "online-song", encoded); err == nil {
		t.Fatal("cancelled artwork revived media after cleanup")
	}
	if media.showing || media.offs != 1 || power.releases != 1 || len(power.leases) != 0 {
		t.Fatal("cleanup did not release original resources")
	}
}
