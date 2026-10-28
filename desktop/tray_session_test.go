package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func trayTestSong(epoch, revision uint64) TrayPlaybackState {
	return TrayPlaybackState{Epoch: epoch, Revision: revision, TrackKey: "song:A", HasSong: true, CanFavorite: true, CanSetMode: true, PlayMode: TrayModeRepeat}
}

func TestTraySessionEpochAndRevocation(t *testing.T) {
	var s traySession
	for want := uint64(1); want <= 3; want++ {
		epoch, err := s.begin()
		if err != nil || epoch != want {
			t.Fatalf("begin=%d %v", epoch, err)
		}
		initial := s.snapshot()
		if initial.Revision != 0 || initial.PlayMode != TrayModeRepeat {
			t.Fatal(initial)
		}
		if _, err := s.request(initial, TrayToggle, nil); err == nil {
			t.Fatal("accepted unsynced song action")
		}
		if _, err := s.request(initial, TrayOpenSettings, nil); err != nil {
			t.Fatal(err)
		}
		s.revoke()
		if s.snapshot() != (TrayPlaybackState{}) || s.matches(initial) {
			t.Fatal("revoke retained identity")
		}
		if err := s.sync(trayTestSong(epoch, 1)); err == nil {
			t.Fatal("accepted revoked epoch")
		}
	}
	s.counter = trayMaxSafeInteger - 1
	if epoch, err := s.begin(); err != nil || epoch != trayMaxSafeInteger {
		t.Fatal(epoch, err)
	}
	if err := s.sync(trayTestSong(trayMaxSafeInteger, trayMaxSafeInteger)); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if epoch, err := s.begin(); err == nil || epoch != 0 || s.snapshot().Epoch != 0 || s.counter != trayMaxSafeInteger {
			t.Fatal("epoch reused on exhaustion")
		}
	}
}

func TestTraySessionSyncValidationIsAtomic(t *testing.T) {
	cases := []struct {
		name   string
		change func(*TrayPlaybackState)
	}{
		{"zero epoch", func(p *TrayPlaybackState) { p.Epoch = 0 }},
		{"wrong epoch", func(p *TrayPlaybackState) { p.Epoch++ }},
		{"unsafe epoch", func(p *TrayPlaybackState) { p.Epoch = trayMaxSafeInteger + 1 }},
		{"zero revision", func(p *TrayPlaybackState) { p.Revision = 0 }},
		{"unsafe revision", func(p *TrayPlaybackState) { p.Revision = trayMaxSafeInteger + 1 }},
		{"missing mode", func(p *TrayPlaybackState) { p.PlayMode = "" }},
		{"unknown mode", func(p *TrayPlaybackState) { p.PlayMode = "invalid" }},
		{"missing key", func(p *TrayPlaybackState) { p.TrackKey = "" }},
		{"no song with key", func(p *TrayPlaybackState) { p.HasSong = false }},
		{"long key", func(p *TrayPlaybackState) { p.TrackKey = strings.Repeat("a", 513) }},
		{"long unicode key", func(p *TrayPlaybackState) { p.TrackKey = strings.Repeat("歌", 171) }},
		{"bad utf8", func(p *TrayPlaybackState) { p.TrackKey = "\xff" }},
		{"newline", func(p *TrayPlaybackState) { p.TrackKey = "a\nb" }},
		{"nul", func(p *TrayPlaybackState) { p.TrackKey = "a\x00b" }},
		{"unicode control", func(p *TrayPlaybackState) { p.TrackKey = "a\u0085b" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var s traySession
			epoch, _ := s.begin()
			before := s.snapshot()
			p := trayTestSong(epoch, 1)
			tc.change(&p)
			if s.sync(p) == nil || s.snapshot() != before {
				t.Fatal("invalid input advanced state")
			}
			if err := s.sync(trayTestSong(epoch, 1)); err != nil {
				t.Fatal("invalid input consumed revision", err)
			}
		})
	}
	var s traySession
	epoch, _ := s.begin()
	p := trayTestSong(epoch, 1)
	p.TrackKey = strings.Repeat("歌", 170) + "ab"
	if err := s.sync(p); err != nil {
		t.Fatal("512-byte UTF8 rejected", err)
	}
	for _, revision := range []uint64{0, 1} {
		p.Revision = revision
		if s.sync(p) == nil {
			t.Fatal("old revision accepted")
		}
	}
	p.Revision = trayMaxSafeInteger
	if err := s.sync(p); err != nil {
		t.Fatal(err)
	}
	p.Revision++
	if s.sync(p) == nil {
		t.Fatal("unsafe next revision accepted")
	}
}

func TestTraySessionNoSong(t *testing.T) {
	var s traySession
	epoch, _ := s.begin()
	empty := TrayPlaybackState{Epoch: epoch, Revision: 1, PlayMode: TrayModeShuffle}
	for _, field := range []string{"playing", "liked", "favorite", "mode"} {
		p := empty
		switch field {
		case "playing":
			p.Playing = true
		case "liked":
			p.Liked = true
		case "favorite":
			p.CanFavorite = true
		case "mode":
			p.CanSetMode = true
		}
		if s.sync(p) == nil {
			t.Fatal("accepted no-song capability", field)
		}
	}
	if err := s.sync(empty); err != nil {
		t.Fatal(err)
	}
	for _, action := range []TrayAction{TrayPrevious, TrayToggle, TrayNext, TrayFavorite, TraySetPlayMode} {
		mode := TrayModeRepeat
		if _, err := s.request(empty, action, &mode); err == nil {
			t.Fatal("accepted no-song request", action)
		}
	}
	if _, err := s.request(empty, TrayOpenSettings, nil); err != nil {
		t.Fatal(err)
	}
}

func TestTraySessionCapturedSnapshot(t *testing.T) {
	var s traySession
	epoch, _ := s.begin()
	a := trayTestSong(epoch, 1)
	if err := s.sync(a); err != nil {
		t.Fatal(err)
	}
	changed := a
	changed.Liked = true
	if s.matches(changed) {
		t.Fatal("partial identity matched")
	}
	if _, err := s.request(changed, TrayFavorite, nil); err == nil {
		t.Fatal("mutated snapshot accepted")
	}
	b := a
	b.Revision = 2
	b.TrackKey = "song:B"
	if err := s.sync(b); err != nil {
		t.Fatal(err)
	}
	again := a
	again.Revision = 3
	if err := s.sync(again); err != nil {
		t.Fatal(err)
	}
	for _, old := range []TrayPlaybackState{a, b} {
		if s.matches(old) {
			t.Fatal("old snapshot matched")
		}
		if _, err := s.request(old, TrayToggle, nil); err == nil {
			t.Fatal("old closure received new identity")
		}
	}
	if _, err := s.request(again, TrayToggle, nil); err != nil {
		t.Fatal(err)
	}
	s.revoke()
	s.begin()
	if _, err := s.request(again, TrayToggle, nil); err == nil {
		t.Fatal("old epoch accepted")
	}
}

func TestTraySessionRequestsAndParameters(t *testing.T) {
	for bits := 0; bits < 8; bits++ {
		var s traySession
		epoch, _ := s.begin()
		p := trayTestSong(epoch, 1)
		p.Liked = bits&1 != 0
		p.CanFavorite = bits&2 != 0
		p.CanSetMode = bits&4 != 0
		if err := s.sync(p); err != nil {
			t.Fatal(err)
		}
		for _, action := range []TrayAction{TrayPrevious, TrayToggle, TrayNext, TrayOpenSettings, TrayFavorite} {
			req, err := s.request(p, action, nil)
			if action == TrayFavorite && !p.CanFavorite {
				if err == nil {
					t.Fatal("favorite capability bypass")
				}
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			if req.Epoch != epoch || req.Revision != 1 || req.TrackKey != p.TrackKey || req.Action != action || req.Mode != nil {
				t.Fatal(req)
			}
			if action == TrayFavorite {
				if req.Favorite == nil || *req.Favorite == p.Liked {
					t.Fatal("wrong desired favorite")
				}
				encoded, err := json.Marshal(req)
				if err != nil {
					t.Fatal(err)
				}
				if p.Liked && !strings.Contains(string(encoded), `"favorite":false`) {
					t.Fatal("false omitted", string(encoded))
				}
			} else if req.Favorite != nil {
				t.Fatal("unrelated favorite")
			}
		}
		for _, mode := range []TrayPlayMode{TrayModeRepeat, TrayModeRepeatOnce, TrayModeShuffle} {
			req, err := s.request(p, TraySetPlayMode, &mode)
			if (err == nil) != p.CanSetMode {
				t.Fatal("mode capability", err)
			}
			if err == nil && (req.Mode == nil || *req.Mode != mode || req.Favorite != nil) {
				t.Fatal(req)
			}
		}
	}
	var s traySession
	epoch, _ := s.begin()
	p := trayTestSong(epoch, 1)
	s.sync(p)
	mode := TrayModeShuffle
	req, err := s.request(p, TraySetPlayMode, &mode)
	if err != nil {
		t.Fatal(err)
	}
	mode = TrayModeRepeatOnce
	if *req.Mode != TrayModeShuffle {
		t.Fatal("request retains caller pointer")
	}
	badMode := TrayPlayMode("bad")
	for _, action := range []TrayAction{TrayPrevious, TrayToggle, TrayNext, TrayOpenSettings, TrayFavorite, "unknown"} {
		if _, err := s.request(p, action, &mode); err == nil {
			t.Fatal("unexpected mode accepted", action)
		}
	}
	if _, err := s.request(p, TraySetPlayMode, nil); err == nil {
		t.Fatal("missing mode accepted")
	}
	if _, err := s.request(p, TraySetPlayMode, &badMode); err == nil {
		t.Fatal("bad mode accepted")
	}
	if _, err := s.request(p, "unknown", nil); err == nil {
		t.Fatal("unknown action accepted")
	}
	yes, no := true, false
	for _, action := range []TrayAction{TrayPrevious, TrayToggle, TrayNext, TrayOpenSettings, TraySetPlayMode} {
		r := TrayRequest{Epoch: epoch, Revision: 1, TrackKey: p.TrackKey, Action: action, Favorite: &no}
		if action == TraySetPlayMode {
			r.Mode = &mode
		}
		if s.validateRequest(p, r) == nil {
			t.Fatal("unrelated favorite accepted", action)
		}
	}
	for _, r := range []TrayRequest{
		{Epoch: epoch, Revision: 1, TrackKey: p.TrackKey, Action: TrayFavorite},
		{Epoch: epoch, Revision: 1, TrackKey: p.TrackKey, Action: TrayFavorite, Favorite: &no},
		{Epoch: epoch, Revision: 1, TrackKey: p.TrackKey, Action: TrayFavorite, Favorite: &yes, Mode: &mode},
		{Epoch: epoch, Revision: 2, TrackKey: p.TrackKey, Action: TrayToggle},
		{Epoch: epoch + 1, Revision: 1, TrackKey: p.TrackKey, Action: TrayToggle},
		{Epoch: epoch, Revision: 1, TrackKey: "other", Action: TrayToggle},
	} {
		if s.validateRequest(p, r) == nil {
			t.Fatal("invalid request accepted", r)
		}
	}
}
