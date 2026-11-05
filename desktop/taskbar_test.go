package main

import (
	"errors"
	"math"
	"testing"
)

type fakeTaskbar struct {
	updates        []TaskbarState
	clears, closes int
	fail           bool
}

func (f *fakeTaskbar) sync(s TaskbarState) error {
	if f.fail {
		return errors.New("native failure")
	}
	f.updates = append(f.updates, s)
	return nil
}
func (f *fakeTaskbar) clear() error { f.clears++; return nil }
func (f *fakeTaskbar) close() error { f.closes++; return nil }
func taskbarFixture() TaskbarState {
	return TaskbarState{Seq: 1, Enabled: true, Playing: true, PositionMs: 500, DurationMs: 1000, Labels: TaskbarLabels{Previous: "Previous", Play: "Play", Pause: "Pause", Next: "Next"}}
}

func TestTaskbarOwnerSwitchAndDisabled(t *testing.T) {
	var clicks []func(TaskbarAction)
	var events []TaskbarCommand
	var backends []*fakeTaskbar
	c := taskbarController{open: func(_ uintptr, click func(TaskbarAction), _ func()) (taskbarBackend, error) {
		f := &fakeTaskbar{}
		backends = append(backends, f)
		clicks = append(clicks, click)
		return f, nil
	}, emit: func(e TaskbarCommand) { events = append(events, e) }}
	epoch, err := c.begin(100)
	requireTestNoError(t, err)
	s := taskbarFixture()
	s.Epoch = epoch
	requireTestNoError(t, c.sync(s))
	clicks[0](TaskbarNext)
	clicks[0]("unsafe")
	if len(events) != 1 || events[0].Seq != 1 {
		t.Fatal(events)
	}
	if c.sync(s) == nil {
		t.Fatal("duplicate sequence accepted")
	}
	s.Seq = 2
	s.Playing = false
	s.DurationMs = 0
	s.PositionMs = 0
	requireTestNoError(t, c.sync(s))
	s.Seq = 3
	s.Enabled = false
	requireTestNoError(t, c.sync(s))
	clicks[0](TaskbarNext)
	if len(events) != 1 || backends[0].clears != 1 || backends[0].closes != 0 {
		t.Fatal("disable retained command gate or closed HWND backend")
	}
	s.Seq = 4
	s.Enabled = true
	if err = c.sync(s); err != nil {
		t.Fatal(err)
	}
	if len(backends) != 1 || len(backends[0].updates) != 3 {
		t.Fatal("enable reinstalled HWND backend")
	}
	requireTestNoError(t, c.revoke())
	clicks[0](TaskbarToggle)
	if len(events) != 1 {
		t.Fatal("retired owner accepted")
	}
	next, _ := c.begin(100)
	if next == epoch {
		t.Fatal("epoch reused")
	}
	if c.sync(s) == nil {
		t.Fatal("old epoch accepted")
	}
	s.Epoch = next
	s.Seq = 1
	if err = c.sync(s); err != nil {
		t.Fatal(err)
	}
	if len(backends) != 1 {
		t.Fatal("Ready replacement reinstalled HWND backend")
	}
	requireTestNoError(t, c.shutdown())
	requireTestNoError(t, c.shutdown())
	if backends[0].closes != 1 {
		t.Fatal("double release")
	}
	// A real destruction/recreation may reuse the numeric HWND. The old hook's generation stays retired.
	next, _ = c.begin(100)
	s.Epoch = next
	s.Seq = 1
	if err = c.sync(s); err != nil {
		t.Fatal(err)
	}
	clicks[0](TaskbarNext)
	if len(events) != 1 {
		t.Fatal("old HWND callback accepted")
	}
	clicks[1](TaskbarPrevious)
	if len(events) != 2 || events[1].Epoch != next {
		t.Fatal(events)
	}
}

func TestTaskbarNativeFailureAndRebuild(t *testing.T) {
	var restart func()
	opens := 0
	f := &fakeTaskbar{}
	c := taskbarController{open: func(_ uintptr, _ func(TaskbarAction), rebuild func()) (taskbarBackend, error) {
		opens++
		restart = rebuild
		return f, nil
	}}
	e, _ := c.begin(12)
	s := taskbarFixture()
	s.Epoch = e
	if err := c.sync(s); err != nil {
		t.Fatal(err)
	}
	restart()
	if len(f.updates) != 2 {
		t.Fatal("Explorer rebuild did not replay accepted state")
	}
	s.Seq++
	s.Enabled = false
	if err := c.sync(s); err != nil {
		t.Fatal(err)
	}
	restart()
	if len(f.updates) != 2 {
		t.Fatal("disabled rebuild restored buttons")
	}
	s.Seq++
	s.Enabled = true
	f.fail = true
	if c.sync(s) == nil || f.clears < 3 {
		t.Fatal("failed sync retained native command gate")
	}
	if c.state.Epoch != 0 || opens != 1 {
		t.Fatal("failure reported active")
	}
	requireTestNoError(t, c.shutdown())
	if f.closes != 1 {
		t.Fatal("failed owner leaked at final shutdown")
	}
	c = taskbarController{open: func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error) {
		return nil, errors.New("COM failure")
	}}
	e, _ = c.begin(12)
	s = taskbarFixture()
	s.Epoch = e
	if c.sync(s) == nil || c.state.Epoch != 0 {
		t.Fatal("COM failure reported success")
	}
}

func TestTaskbarRanges(t *testing.T) {
	for _, v := range []float64{-1, 0.5, 9007199254740992, math.NaN(), math.Inf(1)} {
		s := taskbarFixture()
		s.Epoch = 1
		s.PositionMs = v
		if validateTaskbar(s) == nil {
			t.Fatalf("accepted %v", v)
		}
	}
	for _, label := range []string{"", "\x00", "a\nb", string([]byte{0xff})} {
		s := taskbarFixture()
		s.Epoch = 1
		s.Labels.Play = label
		if validateTaskbar(s) == nil {
			t.Fatal("invalid label")
		}
	}
	s := taskbarFixture()
	s.Epoch = 1
	s.Seq = 0
	if validateTaskbar(s) == nil {
		t.Fatal("zero sequence")
	}
	s.Seq = 1
	s.DurationMs = 0
	if validateTaskbar(s) == nil {
		t.Fatal("position beyond duration")
	}
	c := taskbarController{}
	if _, err := c.begin(0); err == nil {
		t.Fatal("zero handle accepted")
	}
	c.counter = taskbarSafe
	if _, err := c.begin(1); err == nil {
		t.Fatal("epoch exhausted")
	}
}
