package main

import (
	"context"
	"testing"
)

func TestLyricsLockPolicyRequiresVisibleWindowAndExternalUnlock(t *testing.T) {
	for _, stage := range []string{"closed", "pending", "visible without tray", "cancelled owner"} {
		t.Run(stage, func(t *testing.T) {
			s, owner := lyricsTestState(t)
			if stage != "closed" {
				s.open()
			}
			if stage == "visible without tray" || stage == "cancelled owner" {
				s.ready, s.attached = true, true
				s.shown()
			}
			if stage == "cancelled owner" {
				ctx, cancel := context.WithCancel(owner)
				s.owner = ctx
				cancel()
			}
			before := s.window
			if err := s.setLocked(true, stage != "visible without tray"); err == nil {
				t.Fatal("unsafe lock accepted")
			}
			if s.window != before {
				t.Fatal("rejected lock changed window state")
			}
		})
	}
}

func TestLyricsLockPolicyUnlockCloseReopenAndStaleGeneration(t *testing.T) {
	s, owner := lyricsTestState(t)
	first := s.open()
	s.ready, s.attached = true, true
	s.shown()
	revision := s.window.Revision
	requireTestNoError(t, s.setLocked(true, true))
	requireTestEqual(t, s.window.Locked, true)
	requireTestEqual(t, s.window.HoverUnlock, false)
	requireTestEqual(t, s.window.Revision, revision+1)
	if err := s.setLocked(true, true); err != nil || s.window.Revision != revision+1 {
		t.Fatal("duplicate lock must not advance revision", err)
	}
	// Native recovery does not depend on a live renderer or a remaining tray.
	s.owner = nil
	if err := s.setLocked(false, false); err != nil || s.window.Locked || s.window.Revision != revision+2 {
		t.Fatal("external unlock failed", err)
	}
	s.owner = owner
	if err := s.setLocked(true, true); err != nil {
		t.Fatal(err)
	}
	requireTestEqual(t, s.close(first, "synthetic-failure"), true)
	requireTestEqual(t, s.window.Locked, false)
	requireTestEqual(t, s.window.Visible, false)
	requireTestEqual(t, s.window.Pending, false)
	requireTestEqual(t, s.window.Failure, "synthetic-failure")
	second := s.open()
	if s.window.Locked || s.window.Failure != "" || !s.window.Pending {
		t.Fatal("reopen inherited failed or locked state", s.window)
	}
	s.ready, s.attached = true, true
	s.shown()
	if err := s.setLocked(true, true); err != nil {
		t.Fatal(err)
	}
	before := s.window
	if s.close(first, "late callback") || s.window != before {
		t.Fatal("old native callback changed current locked window")
	}
	if !s.close(second, "") {
		t.Fatal("current generation close failed")
	}
	s.revoke()
	if s.window.Locked || s.window.HoverUnlock {
		t.Fatal("revocation retained lock")
	}
	if _, err := s.begin(owner); err != nil {
		t.Fatal(err)
	}
	if err := s.authorize(owner, 1, true, false, true); err == nil {
		t.Fatal("old epoch authorized lock request")
	}
	child := context.WithValue(owner, testContextKey{}, "current child")
	if err := s.authorize(child, s.epoch, false, true, true); err != nil {
		t.Fatal("exact current child must be allowed to request lock", err)
	}
	if err := s.authorize(child, s.epoch, false, false, true); err == nil {
		t.Fatal("unrelated child authorized")
	}
}
