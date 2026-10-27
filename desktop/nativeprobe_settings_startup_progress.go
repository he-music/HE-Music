//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"sync"
	"time"
)

type startupProgressPhase uint8

const (
	startupProgressAppRun startupProgressPhase = iota
	startupProgressAppReady
	startupProgressControlledLoad
	startupProgressCollector
	startupProgressWindowAtStart
	startupProgressShellWait
	startupProgressShellNativeRead
	startupProgressLongEval
	startupProgressDTO
	startupProgressCleanup
	startupProgressDeadline
	startupProgressResultSeal
	startupProgressPhaseCount
)

type startupProgressOutcome string

const (
	startupProgressNotReached startupProgressOutcome = "not-reached"
	startupProgressEntered    startupProgressOutcome = "entered"
	startupProgressReturned   startupProgressOutcome = "returned"
	startupProgressTimeout    startupProgressOutcome = "timeout"
)

var startupProgressNames = [startupProgressPhaseCount]string{
	"appRun", "appReady", "controlledLoad", "collector", "windowAtStart", "shellWait",
	"shellNativeRead", "longEval", "dto", "cleanup", "deadline", "resultSeal",
}

type startupProgressSlot struct {
	Phase         string                 `json:"phase"`
	Outcome       startupProgressOutcome `json:"outcome"`
	EnteredCount  uint64                 `json:"enteredCount"`
	ReturnedCount uint64                 `json:"returnedCount"`
	FirstEntered  *time.Duration         `json:"firstEnteredNs"`
	LastEntered   *time.Duration         `json:"lastEnteredNs"`
	LastReturned  *time.Duration         `json:"lastReturnedNs"`
	LastOutcomeAt *time.Duration         `json:"lastOutcomeAtNs"`
}

type startupProgressSnapshot struct {
	Slots             [startupProgressPhaseCount]startupProgressSlot `json:"slots"`
	LastNative        *startupNativeSnapshot                         `json:"lastNative"`
	CollectorReturned bool                                           `json:"collectorReturned"`
	CleanupReturned   bool                                           `json:"cleanupReturned"`
	// A missing DTO leaves DOM, Vue flush, timer and RAF unknown, even if JS sampled internally.
	SurfaceEvidence string `json:"surfaceEvidence"`
}

// The caller supplies elapsed monotonic duration. This recorder performs no system reads,
// waits or joins. Zero is a valid timestamp; nil means the boundary was not recorded.
// Seal freezes only recorded facts, and never backfills the existing result/failures.
type startupProgressRecorder struct {
	mu     sync.Mutex
	clock  func() time.Duration
	sealed bool
	state  startupProgressSnapshot
}

func newStartupProgressRecorder(clock func() time.Duration) *startupProgressRecorder {
	r := &startupProgressRecorder{clock: clock}
	r.state.SurfaceEvidence = "unknown"
	for phase := startupProgressPhase(0); phase < startupProgressPhaseCount; phase++ {
		r.state.Slots[phase] = startupProgressSlot{Phase: startupProgressNames[phase], Outcome: startupProgressNotReached}
	}
	return r
}

func startupProgressDuration(value time.Duration) *time.Duration { return &value }

func (r *startupProgressRecorder) record(phase startupProgressPhase, outcome startupProgressOutcome, native *startupNativeSnapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sealed || phase >= startupProgressPhaseCount {
		return
	}
	r.recordLocked(phase, outcome)
	if native != nil {
		copy := *native
		r.state.LastNative = &copy
	}
}

func (r *startupProgressRecorder) recordLocked(phase startupProgressPhase, outcome startupProgressOutcome) {
	slot := &r.state.Slots[phase]
	at := r.clock()
	slot.LastOutcomeAt = startupProgressDuration(at)
	if outcome == startupProgressEntered {
		if slot.FirstEntered == nil {
			slot.FirstEntered = startupProgressDuration(at)
		}
		slot.LastEntered = startupProgressDuration(at)
		if slot.EnteredCount < ^uint64(0) {
			slot.EnteredCount++
		}
	} else if outcome == startupProgressReturned {
		slot.LastReturned = startupProgressDuration(at)
		if slot.ReturnedCount < ^uint64(0) {
			slot.ReturnedCount++
		}
	}
	slot.Outcome = outcome
}

func (r *startupProgressRecorder) Enter(phase startupProgressPhase) {
	r.record(phase, startupProgressEntered, nil)
}

func (r *startupProgressRecorder) Returned(phase startupProgressPhase) {
	r.record(phase, startupProgressReturned, nil)
}

func (r *startupProgressRecorder) Timeout(phase startupProgressPhase) {
	r.record(phase, startupProgressTimeout, nil)
}

// NativeReturned is used only after the shell's existing native read actually returns.
func (r *startupProgressRecorder) NativeReturned(native startupNativeSnapshot) {
	r.record(startupProgressShellNativeRead, startupProgressReturned, &native)
}

func (r *startupProgressRecorder) Seal() startupProgressSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.sealed {
		r.recordLocked(startupProgressResultSeal, startupProgressEntered)
		r.recordLocked(startupProgressResultSeal, startupProgressReturned)
		r.state.CollectorReturned = r.state.Slots[startupProgressCollector].ReturnedCount != 0
		r.state.CleanupReturned = r.state.Slots[startupProgressCleanup].ReturnedCount != 0
		if r.state.Slots[startupProgressDTO].ReturnedCount != 0 {
			r.state.SurfaceEvidence = "returned-dto"
		}
		r.sealed = true
	}
	// Return independent values so callers cannot mutate the frozen snapshot through pointers.
	copy := r.state
	for i := range copy.Slots {
		source := r.state.Slots[i]
		if source.LastOutcomeAt != nil {
			copy.Slots[i].LastOutcomeAt = startupProgressDuration(*source.LastOutcomeAt)
		}
		if source.FirstEntered != nil {
			copy.Slots[i].FirstEntered = startupProgressDuration(*source.FirstEntered)
		}
		if source.LastEntered != nil {
			copy.Slots[i].LastEntered = startupProgressDuration(*source.LastEntered)
		}
		if source.LastReturned != nil {
			copy.Slots[i].LastReturned = startupProgressDuration(*source.LastReturned)
		}
	}
	if r.state.LastNative != nil {
		native := *r.state.LastNative
		copy.LastNative = &native
	}
	return copy
}
