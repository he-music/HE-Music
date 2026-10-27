//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestStartupProgressTotalDeadlineBeforeLocalTimeout(t *testing.T) {
	var elapsed time.Duration
	r := newStartupProgressRecorder(func() time.Duration { return elapsed })
	r.Enter(startupProgressDeadline)
	elapsed = 15 * time.Second
	r.Enter(startupProgressShellWait)
	elapsed = 20 * time.Second
	r.Timeout(startupProgressDeadline)
	s := r.Seal()
	if s.Slots[startupProgressShellWait].Outcome != startupProgressEntered || s.Slots[startupProgressDeadline].Outcome != startupProgressTimeout {
		t.Fatal("total deadline must not imply the shell's local eight-second timeout")
	}
	if s.Slots[startupProgressDeadline].LastOutcomeAt == nil || *s.Slots[startupProgressDeadline].LastOutcomeAt != 20*time.Second {
		t.Fatal("total deadline firing must retain its actual relative timestamp")
	}
	if *s.Slots[startupProgressDeadline].FirstEntered != 0 || *s.Slots[startupProgressShellWait].FirstEntered != 15*time.Second {
		t.Fatal("zero is a valid relative timestamp")
	}
}

func TestStartupProgressNativeEnteredWithoutReturn(t *testing.T) {
	r := newStartupProgressRecorder(func() time.Duration { return 0 })
	r.Enter(startupProgressShellNativeRead)
	s := r.Seal()
	if s.LastNative != nil || s.Slots[startupProgressShellNativeRead].LastReturned != nil {
		t.Fatal("an unreturned native read must leave gates and disabled flags unknown")
	}
	encoded, err := json.Marshal(s)
	if err != nil || len(encoded) == 0 {
		t.Fatal("snapshot must encode")
	}
}

func TestStartupProgressControlledLoadIsNotFrontendReady(t *testing.T) {
	r := newStartupProgressRecorder(func() time.Duration { return 0 })
	r.Enter(startupProgressControlledLoad)
	r.Returned(startupProgressControlledLoad)
	r.Enter(startupProgressCollector)
	s := r.Seal()
	if s.SurfaceEvidence != "unknown" || s.LastNative != nil || s.Slots[startupProgressDTO].Outcome != startupProgressNotReached || s.CollectorReturned {
		t.Fatal("controlled load cannot establish frontend Ready, returned DTO, or collector completion")
	}
}

func TestStartupProgressUnreturnedDTOAndLateWrites(t *testing.T) {
	r := newStartupProgressRecorder(func() time.Duration { return 0 })
	r.Enter(startupProgressLongEval)
	// JS may have sampled internally. Only a decoded, returned DTO is observable here.
	r.Enter(startupProgressDTO)
	r.Enter(startupProgressCleanup)
	sealed := r.Seal()
	r.Returned(startupProgressDTO)
	r.Returned(startupProgressLongEval)
	r.Returned(startupProgressCollector)
	r.Returned(startupProgressCleanup)
	r.NativeReturned(startupNativeSnapshot{Ready: true})
	if !reflect.DeepEqual(sealed, r.Seal()) || sealed.SurfaceEvidence != "unknown" || sealed.CleanupReturned {
		t.Fatal("late writes must not reinterpret the sealed unknown surface or completion")
	}
	*sealed.Slots[startupProgressLongEval].FirstEntered = time.Hour
	if *r.Seal().Slots[startupProgressLongEval].FirstEntered != 0 {
		t.Fatal("returned pointers must not mutate frozen state")
	}
}

func TestStartupProgressLatestNativeAndConcurrentSeal(t *testing.T) {
	r := newStartupProgressRecorder(func() time.Duration { return 0 })
	r.Enter(startupProgressShellNativeRead)
	r.NativeReturned(startupNativeSnapshot{Ready: true})
	r.Enter(startupProgressShellNativeRead)
	r.NativeReturned(startupNativeSnapshot{MediaConfigured: true})
	r.Returned(startupProgressDTO)
	s := r.Seal()
	if s.Slots[startupProgressShellNativeRead].EnteredCount != 2 || s.Slots[startupProgressShellNativeRead].ReturnedCount != 2 || s.LastNative.Ready || !s.LastNative.MediaConfigured || s.SurfaceEvidence != "returned-dto" {
		t.Fatal("fixed slot must retain counts and the most recent real returned values")
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r.Enter(startupProgressCollector)
			r.Returned(startupProgressCleanup)
			if !reflect.DeepEqual(s, r.Seal()) {
				t.Error("concurrent late writes changed seal")
			}
		}()
	}
	close(start)
	wg.Wait()
}

func TestStartupProgressConcurrentFirstSeal(t *testing.T) {
	r := newStartupProgressRecorder(func() time.Duration { return 0 })
	start := make(chan struct{})
	results := make(chan startupProgressSnapshot, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		r.Enter(startupProgressCollector)
		r.Returned(startupProgressCollector)
		results <- r.Seal()
	}()
	go func() {
		defer wg.Done()
		<-start
		results <- r.Seal()
	}()
	close(start)
	wg.Wait()
	a, b := <-results, <-results
	if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(a, r.Seal()) {
		t.Fatal("all seals must agree regardless of write/seal ordering")
	}
}
