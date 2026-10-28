package main

import (
	"context"
	"errors"
	"time"
)

var errUpdatesUnavailable = errors.New("updates unavailable")

// All fields belong to the injected serial dispatcher. Workers only retain
// captured contexts/candidates; they post results back before inspecting state.
type updatesSession struct {
	service   *Updates
	driver    updatesDriver
	owner     context.Context
	stopOwner func() bool
	cancel    context.CancelFunc
	nextEpoch uint64
	state     UpdatesState
	candidate updatesCandidate
	// This fence outlives every owner/epoch, even when SDK cancellation fails.
	installBusy bool
}

func newUpdates(driver updatesDriver, post func(func()), valid func(context.Context) bool, emit func(context.Context, UpdatesEvent) error) *Updates {
	u := &Updates{post: post, valid: valid, emit: emit}
	u.session = updatesSession{service: u, driver: driver, state: UpdatesState{Phase: "inactive"}}
	return u
}

func (s *updatesSession) snapshot() UpdatesState {
	state := s.state
	state.InstallBusy = s.installBusy
	return state
}

func (s *updatesSession) touch() { s.state.StateRevision++ }

func (s *updatesSession) begin(owner context.Context) string {
	s.revoke()
	s.nextEpoch++
	s.owner = owner
	s.state = UpdatesState{Epoch: s.nextEpoch, StateRevision: 1, Phase: "idle"}
	epoch := s.state.Epoch
	s.stopOwner = context.AfterFunc(owner, func() {
		s.service.post(func() {
			if s.owner == owner && s.state.Epoch == epoch {
				s.revoke()
			}
		})
	})
	return ""
}

func (s *updatesSession) owns(owner context.Context, epoch uint64) string {
	if owner.Err() != nil || s.owner != owner || epoch == 0 || s.state.Epoch != epoch {
		return "session-unavailable"
	}
	return ""
}

func (s *updatesSession) operation(owner context.Context, epoch, revision uint64) string {
	if code := s.owns(owner, epoch); code != "" {
		return code
	}
	if s.installBusy {
		return "install-busy"
	}
	if revision == 0 || revision <= s.state.OperationRevision {
		return "stale-operation"
	}
	return ""
}

func (s *updatesSession) stopWork() {
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

func (s *updatesSession) revoke() {
	s.stopWork()
	if s.stopOwner != nil {
		s.stopOwner()
		s.stopOwner = nil
	}
	s.owner = nil
	s.candidate = nil
	s.state.Phase, s.state.Code = "inactive", ""
	s.state.Version, s.state.Notes, s.state.Date = "", "", ""
	s.touch()
}

func (s *updatesSession) current(owner context.Context, epoch, revision uint64) bool {
	return s.owns(owner, epoch) == "" && s.state.OperationRevision == revision && s.service.valid(owner)
}

func (s *updatesSession) check(owner context.Context, epoch, revision, requestID uint64) string {
	if code := s.operation(owner, epoch, revision); code != "" {
		return code
	}
	s.stopWork()
	s.candidate = nil
	s.state.OperationRevision = revision
	s.state.Phase, s.state.Code = "checking", ""
	s.state.Version, s.state.Notes, s.state.Date = "", "", ""
	s.touch()
	ctx, cancel := context.WithTimeout(owner, 2*time.Minute)
	s.cancel = cancel
	go func() {
		candidate, err := s.driver.check(ctx)
		if ctx.Err() != nil {
			candidate, err = nil, ctx.Err()
		}
		cancel()
		s.service.post(func() {
			if !s.current(owner, epoch, revision) {
				return
			}
			s.cancel = nil
			switch {
			case errors.Is(err, errUpdatesUnavailable):
				s.state.Phase, s.state.Code = "unavailable", "unavailable"
			case err != nil:
				s.state.Phase, s.state.Code = "error", "check-failed"
			case candidate == nil:
				s.state.Phase = "no-update"
			default:
				s.candidate = candidate
				s.state.Version, s.state.Notes, s.state.Date = candidate.metadata()
				s.state.Phase = "available"
			}
			s.touch()
			s.service.publish(owner, requestID, "")
		})
	}()
	return ""
}

func (s *updatesSession) install(owner context.Context, epoch, revision, requestID uint64) string {
	if code := s.operation(owner, epoch, revision); code != "" {
		return code
	}
	if s.state.Phase != "available" || s.candidate == nil {
		return "candidate-unavailable"
	}
	s.stopWork()
	candidate := s.candidate
	s.candidate = nil // A candidate is consumed once, even if SDK reports an error.
	s.installBusy = true
	s.state.OperationRevision = revision
	s.state.Phase, s.state.Code = "installing", ""
	s.touch()
	ctx, cancel := context.WithTimeout(owner, 30*time.Minute)
	s.cancel = cancel
	go func() {
		// SDK owns the combined download/verify/swap. No progress callback is
		// presented as a separable downloaded or safe-to-cancel stage.
		err := candidate.install(ctx)
		cancel()
		s.service.post(func() {
			// Only actual SDK return releases this fence, never revoke/timeout.
			s.installBusy = false
			if !s.current(owner, epoch, revision) {
				// New owners may learn the fence cleared, never the old result.
				if s.owner != nil && s.owner.Err() == nil {
					s.touch()
					s.service.publish(s.owner, 0, "")
				}
				return
			}
			s.cancel = nil
			if err != nil {
				s.state.Phase, s.state.Code = "error", "install-failed"
			} else {
				s.state.Phase, s.state.Code = "installed", "restart-required"
			}
			s.touch()
			s.service.publish(owner, requestID, "")
		})
	}()
	return ""
}
