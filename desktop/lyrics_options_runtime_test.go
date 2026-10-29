package main

import "testing"

func TestLyricsOptionsLockedSizeDefersNativeBounds(t *testing.T) {
	options := defaultLyricsOptions()
	options.Font.Size = 96
	before := LyricsBounds{X: -700, Y: 20, Width: 800, Height: 180}
	l := DesktopLyrics{appliedFontSize: 24}
	l.state.window = LyricsWindowState{Locked: true, Bounds: before}
	l.state.snapshot = &LyricsSnapshot{Options: &options}
	if err := l.syncOptionsBounds(); err != nil {
		t.Fatal(err)
	}
	if l.state.window.Bounds != before || l.appliedFontSize != 24 {
		t.Fatal("locked window moved or consumed deferred size")
	}
	if l.optionsFontSize() != 96 {
		t.Fatal("lost desired font size")
	}
	l.state.snapshot = nil
	if l.optionsFontSize() != 24 {
		t.Fatal("missing legacy default size")
	}
}

func TestLyricsOptionsWorkAreaUsesOneDisplayAndClonesAttachment(t *testing.T) {
	areas := []LyricsBounds{{X: -1200, Y: 0, Width: 1200, Height: 900}, {X: 400, Y: 100, Width: 1000, Height: 800}}
	bounds := LyricsBounds{X: -1000, Y: 200, Width: 800, Height: 180}
	area := lyricsWorkAreaForBounds(bounds, areas)
	if area == nil || *area != areas[0] {
		t.Fatalf("wrong work area: %v", area)
	}
	area.X = 99
	if areas[0].X != -1200 {
		t.Fatal("work area aliases caller input")
	}
	if lyricsWorkAreaForBounds(bounds, nil) != nil {
		t.Fatal("invented screen")
	}
	state, _ := lyricsTestState(t)
	state.window.WorkArea = &areas[0]
	attached := state.attachment()
	attached.Window.WorkArea.X = 0
	if state.window.WorkArea.X != -1200 {
		t.Fatal("attachment aliases work area")
	}
}
