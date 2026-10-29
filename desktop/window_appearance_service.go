package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

// AppliedUseBorderless describes this window; UseBorderless is the saved next-start value.
type WindowAppearanceState struct {
	UseBorderless        bool `json:"useBorderless"`
	AppliedUseBorderless bool `json:"appliedUseBorderless"`
	RestartRequired      bool `json:"restartRequired"`
	LoadFailed           bool `json:"loadFailed"`
}

type WindowAppearanceService struct {
	store   *WindowAppearanceStore
	desired WindowAppearance
	applied WindowAppearance
	failed  bool
}

var desktopWindowAppearance = &WindowAppearanceService{}

func init() { mygo.Bind(desktopWindowAppearance) }

func (s *WindowAppearanceService) snapshot() WindowAppearanceState {
	return WindowAppearanceState{
		UseBorderless:        s.desired.UseBorderless,
		AppliedUseBorderless: s.applied.UseBorderless,
		RestartRequired:      s.desired.UseBorderless != s.applied.UseBorderless,
		LoadFailed:           s.failed,
	}
}

// initialize is called once, before creating the main window, with an application-owned path.
func (s *WindowAppearanceService) initialize(path string) (WindowAppearance, error) {
	store, err := NewWindowAppearanceStore(path)
	if err != nil {
		return WindowAppearance{}, err
	}
	s.store = store
	appearance, _, err := store.Load()
	s.desired, s.applied, s.failed = appearance, appearance, err != nil
	return appearance, err
}

func (s *WindowAppearanceService) save(useBorderless bool) (WindowAppearanceState, error) {
	if s.store == nil {
		return s.snapshot(), errors.New("window appearance unavailable")
	}
	next := WindowAppearance{UseBorderless: useBorderless}
	if _, err := s.store.Save(next); err != nil {
		return s.snapshot(), err
	}
	s.desired, s.failed = next, false
	return s.snapshot(), nil
}

func (s *WindowAppearanceService) Current(ctx context.Context) (WindowAppearanceState, error) {
	var state WindowAppearanceState
	err := desktopLifecycle.call(ctx, true, func() error {
		if s.store == nil {
			return errors.New("window appearance unavailable")
		}
		state = s.snapshot()
		return nil
	})
	return state, err
}

func (s *WindowAppearanceService) Save(ctx context.Context, useBorderless bool) (WindowAppearanceState, error) {
	var state WindowAppearanceState
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		state, err = s.save(useBorderless)
		return err
	})
	return state, err
}

func prepareWindowAppearance(directory string) (WindowAppearance, error) {
	if os.Getenv("MYGO_GENERATE") != "" {
		return WindowAppearance{}, nil
	}
	if directory == "" || !filepath.IsAbs(directory) {
		return WindowAppearance{}, errors.New("window appearance unavailable")
	}
	return desktopWindowAppearance.initialize(filepath.Join(directory, "window-appearance.json"))
}
