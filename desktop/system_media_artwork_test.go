package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func systemMediaArtworkFixture(t *testing.T, format string, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	img.SetNRGBA(0, 0, color.NRGBA{R: 123, G: 45, B: 67, A: 255})
	var out bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&out, img)
	case "jpeg":
		err = jpeg.Encode(&out, img, &jpeg.Options{Quality: 80})
	case "gif":
		err = gif.Encode(&out, img, nil)
	default:
		t.Fatalf("unsupported fixture format: %s", format)
	}
	if err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func newSystemMediaArtworkTest(t *testing.T) (*systemMediaState, *fakeSystemMedia, *fakeSystemPower, context.Context, uint64) {
	t.Helper()
	s, media, power, _ := newSystemMediaTest()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	status, err := s.configure(ctx, 0, true, true)
	if err != nil {
		t.Fatal(err)
	}
	track := systemMediaTestTrack()
	track.State, track.Rate, track.PositionMS = "playing", 1.75, 1000
	if err := s.set(ctx, status.Generation, 1, track); err != nil {
		t.Fatal(err)
	}
	return s, media, power, ctx, status.Generation
}

func TestSystemMediaArtworkSetsClearsAndPreservesCurrentSnapshot(t *testing.T) {
	for _, format := range []string{"png", "jpeg"} {
		t.Run(format, func(t *testing.T) {
			s, media, power, ctx, gen := newSystemMediaArtworkTest(t)
			encodedBytes := systemMediaArtworkFixture(t, format, 4, 3)
			encoded := base64.StdEncoding.EncodeToString(encodedBytes)
			// Simulate Info's advanced playing clock, distinct from original Set.
			media.info.Position = 3500 * time.Millisecond
			before := media.info
			if err := s.artwork(ctx, gen, 1, s.trackID, encoded); err != nil {
				t.Fatal(err)
			}
			want := before
			want.Artwork = encodedBytes
			if !reflect.DeepEqual(media.info, want) || media.infoReads != 1 {
				t.Fatalf("artwork rewrote current module snapshot: %#v", media.info)
			}
			// An accepted pause/seek after Set must survive a late cover.
			if err := s.playback(ctx, gen, 1, s.trackID, "paused", 6500); err != nil {
				t.Fatal(err)
			}
			if err := s.artwork(ctx, gen, 1, s.trackID, encoded); err != nil {
				t.Fatal(err)
			}
			if media.info.State != mygo.PlaybackPaused || media.info.Position != 6500*time.Millisecond || media.info.Rate != 1.75 {
				t.Fatal("artwork reset accepted pause, seek or rate", media.info)
			}
			before = media.info
			if err := s.artwork(ctx, gen, 1, s.trackID, ""); err != nil {
				t.Fatal(err)
			}
			before.Artwork = nil
			if !reflect.DeepEqual(media.info, before) || media.infoReads != 3 || len(media.sets) != 4 {
				t.Fatal("empty artwork failed to clear only the current image")
			}
			if len(media.callbacks) != 1 || media.offs != 0 || media.clears != 0 || power.next != 1 || power.releases != 0 || len(power.leases) != 1 {
				t.Fatal("artwork recreated command subscription or power lease")
			}
		})
	}
}

func TestSystemMediaArtworkUsesLatestRateRevision(t *testing.T) {
	s, media, _, ctx, gen := newSystemMediaArtworkTest(t)
	track := systemMediaTestTrack()
	track.State, track.Rate, track.PositionMS = "stopped", 2.5, 7000
	if err := s.set(ctx, gen, 2, track); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "png", 2, 2))
	if err := s.artwork(ctx, gen, 1, track.ID, encoded); err == nil {
		t.Fatal("old rate revision accepted artwork")
	}
	before := media.info
	if err := s.artwork(ctx, gen, 2, track.ID, encoded); err != nil {
		t.Fatal(err)
	}
	before.Artwork = media.info.Artwork
	if !reflect.DeepEqual(media.info, before) {
		t.Fatal("artwork changed latest rate/state/position/duration/commands")
	}
}

func TestSystemMediaArtworkInvalidDataPreservesSnapshotAndResources(t *testing.T) {
	pngBytes := systemMediaArtworkFixture(t, "png", 3, 2)
	jpegBytes := systemMediaArtworkFixture(t, "jpeg", 3, 2)
	good := base64.StdEncoding.EncodeToString(pngBytes)
	cases := map[string]string{
		"malformed":         "%%%",
		"noncanonical-bits": "/x==",
		"missing-padding":   "YQ",
		"line-break":        good[:4] + "\n" + good[4:],
		"carriage-return":   good[:4] + "\r" + good[4:],
		"data-url":          "data:image/png;base64," + good,
		"url":               "https://invalid.example/synthetic-cover.png",
		"path":              "/synthetic/cover.png",
		"fake-png":          base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nnot an image")),
		"truncated-png":     base64.StdEncoding.EncodeToString(pngBytes[:len(pngBytes)/2]),
		"truncated-jpeg":    base64.StdEncoding.EncodeToString(jpegBytes[:len(jpegBytes)-10]),
		"unsupported-gif":   base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "gif", 2, 2)),
		"width-limit":       base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "png", systemMediaArtworkMaxSide+1, 1)),
		"height-limit":      base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "jpeg", 1, systemMediaArtworkMaxSide+1)),
		"encoded-limit":     strings.Repeat("A", systemMediaArtworkMaxEncoded+1),
		// maxBytes+1 has the same encoded length as maxBytes: check decoded length too.
		"decoded-limit": base64.StdEncoding.EncodeToString(make([]byte, systemMediaArtworkMaxBytes+1)),
	}
	brokenPNG := bytes.Clone(pngBytes)
	brokenPNG[len(brokenPNG)-1] ^= 1
	cases["broken-png-body"] = base64.StdEncoding.EncodeToString(brokenPNG)
	for name, encoded := range cases {
		t.Run(name, func(t *testing.T) {
			s, media, power, ctx, gen := newSystemMediaArtworkTest(t)
			if err := s.artwork(ctx, gen, 1, s.trackID, good); err != nil {
				t.Fatal(err)
			}
			before := media.info
			sets, reads := len(media.sets), media.infoReads
			if err := s.artwork(ctx, gen, 1, s.trackID, encoded); err == nil {
				t.Fatal("invalid artwork accepted")
			}
			if !reflect.DeepEqual(media.info, before) || len(media.sets) != sets || media.infoReads != reads || s.revision != 1 || !s.showing {
				t.Fatal("invalid artwork altered valid metadata or inspected backend")
			}
			if len(media.callbacks) != 1 || media.offs != 0 || power.next != 1 || power.releases != 0 {
				t.Fatal("invalid artwork altered native resource ownership")
			}
		})
	}
}

func TestSystemMediaArtworkDimensionBoundary(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "png", systemMediaArtworkMaxSide, systemMediaArtworkMaxSide))
	if _, err := decodeSystemMediaArtwork(encoded); err != nil {
		t.Fatal("maximum dimensions rejected", err)
	}
}

func TestSystemMediaArtworkRejectsInactiveTargetsBeforeValidation(t *testing.T) {
	cases := []string{"owner", "generation", "revision", "zero-revision", "track", "empty-track", "not-ready", "cancelled", "clear", "disabled", "teardown", "revoke", "new-song", "new-owner"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			s, media, power, ctx, gen := newSystemMediaArtworkTest(t)
			ctx, gen, revision, trackID := inactiveSystemMediaArtworkTarget(t, s, name, ctx, gen)
			before := media.info
			sets, reads, subscriptions, offs, clears := len(media.sets), media.infoReads, len(media.callbacks), media.offs, media.clears
			acquires, releases := power.next, power.releases
			// Invalid base64 must never be parsed for an inactive target, nor may
			// an empty clear or valid late cover resurrect one after cleanup.
			good := base64.StdEncoding.EncodeToString(systemMediaArtworkFixture(t, "png", 1, 1))
			for _, encoded := range []string{"%%%", "", good} {
				err := s.artwork(ctx, gen, revision, trackID, encoded)
				if err == nil || err.Error() != "system media artwork target is no longer active" {
					t.Fatal("target guard did not precede validation", err)
				}
			}
			if !reflect.DeepEqual(media.info, before) || len(media.sets) != sets || media.infoReads != reads || len(media.callbacks) != subscriptions || media.offs != offs || media.clears != clears || power.next != acquires || power.releases != releases {
				t.Fatal("inactive artwork changed state or resurrected resources")
			}
		})
	}
}

func inactiveSystemMediaArtworkTarget(t *testing.T, s *systemMediaState, name string, ctx context.Context, gen uint64) (context.Context, uint64, uint64, string) {
	t.Helper()
	trackID, revision := s.trackID, uint64(1)
	switch name {
	case "owner":
		ctx = context.WithValue(ctx, testContextKey{}, 1)
	case "generation":
		gen++
	case "revision":
		revision++
	case "zero-revision":
		revision = 0
	case "track":
		trackID = "different-track"
	case "empty-track":
		trackID = ""
	case "not-ready":
		s.valid = func(context.Context) bool { return false }
	case "cancelled":
		cancelled, cancel := context.WithCancel(ctx)
		s.owner, ctx = cancelled, cancelled
		cancel()
	case "clear":
		requireTestNoError(t, s.clear(ctx, gen, 2))
	case "disabled":
		if _, err := s.configure(ctx, gen, false, true); err != nil {
			t.Fatal(err)
		}
	case "teardown":
		requireTestNoError(t, s.teardown(ctx, gen))
	case "revoke":
		s.revoke()
	case "new-song":
		track := systemMediaTestTrack()
		track.ID, track.Title = "new-song", "New synthetic song"
		if err := s.set(ctx, gen, 2, track); err != nil {
			t.Fatal(err)
		}
	case "new-owner":
		s.revoke()
		newOwner := context.WithValue(ctx, testContextKey{}, 1)
		status, err := s.configure(newOwner, 0, true, true)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.set(newOwner, status.Generation, 1, systemMediaTestTrack()); err != nil {
			t.Fatal(err)
		}
	}
	return ctx, gen, revision, trackID
}

func TestSystemMediaArtworkBackendNotShowingCannotResurrect(t *testing.T) {
	s, media, _, ctx, gen := newSystemMediaArtworkTest(t)
	media.Clear()
	before := media.info
	sets := len(media.sets)
	if err := s.artwork(ctx, gen, 1, s.trackID, ""); err == nil {
		t.Fatal("non-showing backend accepted artwork")
	}
	if media.showing || len(media.sets) != sets || !reflect.DeepEqual(media.info, before) {
		t.Fatal("artwork resurrected non-showing backend")
	}
}
