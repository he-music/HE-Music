package main

import (
	"errors"
	"math"
	"unicode"
	"unicode/utf8"
)

type TaskbarAction string

const (
	TaskbarPrevious TaskbarAction = "previous"
	TaskbarToggle   TaskbarAction = "toggle"
	TaskbarNext     TaskbarAction = "next"
	taskbarSafe     uint64        = 9007199254740991
)

type TaskbarLabels struct {
	Previous string `json:"previous"`
	Play     string `json:"play"`
	Pause    string `json:"pause"`
	Next     string `json:"next"`
}
type TaskbarState struct {
	Epoch      uint64        `json:"epoch"`
	Seq        uint64        `json:"seq"`
	Enabled    bool          `json:"enabled"`
	Playing    bool          `json:"playing"`
	PositionMs float64       `json:"positionMs"`
	DurationMs float64       `json:"durationMs"`
	Labels     TaskbarLabels `json:"labels"`
}
type TaskbarCommand struct {
	Epoch  uint64        `json:"epoch"`
	Seq    uint64        `json:"seq"`
	Action TaskbarAction `json:"action"`
}

// Failure reports native failure after a Sync RPC has already accepted queued work.
// Synchronous failures remain RPC errors and do not also emit this event.
type TaskbarFailure struct {
	Epoch uint64 `json:"epoch"`
	Seq   uint64 `json:"seq"`
	Code  string `json:"code"`
}
type taskbarBackend interface {
	sync(TaskbarState) error
	clear() error
	close() error
}

// Completion is the sole state-commit point for immediate and queued native work.
type taskbarCompletionBackend interface {
	submit(*TaskbarState, func(error)) error
	accepting() bool
}
type taskbarFactory func(uintptr, func(TaskbarAction), func()) (taskbarBackend, error)

var errTaskbarSuperseded = errors.New("taskbar operation superseded")

type taskbarController struct {
	counter, revision, generation uint64
	handle                        uintptr
	state                         TaskbarState
	requested                     TaskbarState
	backend                       taskbarBackend
	open                          taskbarFactory
	emit                          func(TaskbarCommand)
	failure                       func(TaskbarFailure)
}

func (c *taskbarController) advance() uint64 { c.revision++; return c.revision }
func validateTaskbar(s TaskbarState) error {
	if s.Epoch == 0 || s.Epoch > taskbarSafe || s.Seq == 0 || s.Seq > taskbarSafe {
		return errors.New("invalid taskbar identity")
	}
	for _, n := range []float64{s.PositionMs, s.DurationMs} {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > float64(taskbarSafe) || math.Trunc(n) != n {
			return errors.New("invalid taskbar time")
		}
	}
	if s.PositionMs > s.DurationMs {
		return errors.New("taskbar position exceeds duration")
	}
	for _, label := range []string{s.Labels.Previous, s.Labels.Play, s.Labels.Pause, s.Labels.Next} {
		if label == "" || !utf8.ValidString(label) || len([]rune(label)) > 60 {
			return errors.New("invalid taskbar label")
		}
		for _, r := range label {
			if unicode.IsControl(r) {
				return errors.New("invalid taskbar label")
			}
		}
	}
	return nil
}

func (c *taskbarController) begin(handle uintptr) (uint64, error) {
	op := c.advance()
	backend, previousHandle := c.backend, c.handle
	native, nativeBackend := backend.(taskbarCompletionBackend)
	if err := c.revoke(); err != nil {
		if !taskbarQueuedCleanup(err) || !nativeBackend || !native.accepting() {
			return 0, err
		}
	}
	if c.revision != op+1 || c.backend != backend || c.handle != previousHandle {
		return 0, errTaskbarSuperseded
	}
	if handle == 0 || c.counter >= taskbarSafe {
		return 0, errors.New("taskbar owner unavailable")
	}
	if c.handle != handle {
		before := c.revision
		if err := c.shutdown(); err != nil && (!nativeBackend || !taskbarQueuedCleanup(err)) {
			return 0, err
		}
		if c.revision != before+2 || c.backend != nil || c.handle != 0 {
			return 0, errTaskbarSuperseded
		}
		c.handle = handle
	}
	// Begin transfers only logical ownership. Queued clear/close already shut the
	// native gate; the new owner's Sync still commits solely through completion.
	c.counter++
	c.state = TaskbarState{Epoch: c.counter}
	c.requested = c.state
	c.advance()
	return c.counter, nil
}

func (c *taskbarController) sync(s TaskbarState) error {
	if err := validateTaskbar(s); err != nil {
		return err
	}
	if s.Epoch != c.state.Epoch || s.Seq <= c.state.Seq || (s.Epoch == c.requested.Epoch && s.Seq <= c.requested.Seq) {
		return errors.New("stale taskbar state")
	}
	c.requested = s
	op := c.advance()
	backend, handle, epoch := c.backend, c.handle, c.state.Epoch
	if !s.Enabled {
		if backend == nil {
			c.state = s
			return nil
		}
		return c.applyBackend(s, backend, op, handle, epoch)
	}
	if backend == nil {
		c.generation++
		generation, ownerHandle := c.generation, c.handle
		opened, err := c.open(ownerHandle, c.nativeCommandHandler(generation, ownerHandle), c.nativeRebuildHandler(generation, ownerHandle))
		if err != nil {
			if op == c.revision && c.handle == ownerHandle && c.state.Epoch == epoch {
				_ = c.revoke()
			}
			return err
		}
		if op != c.revision || c.handle != ownerHandle || c.state.Epoch != epoch || c.backend != nil {
			_ = opened.close()
			return errTaskbarSuperseded
		}
		backend = opened
		c.backend = backend
	}
	return c.applyBackend(s, backend, op, handle, epoch)
}

func (c *taskbarController) nativeCommandHandler(generation uint64, handle uintptr) func(TaskbarAction) {
	return func(action TaskbarAction) {
		if c.generation != generation || c.handle != handle || !c.state.Enabled || c.backend == nil {
			return
		}
		if action != TaskbarPrevious && action != TaskbarToggle && action != TaskbarNext {
			return
		}
		if c.emit != nil {
			c.emit(TaskbarCommand{Epoch: c.state.Epoch, Seq: c.state.Seq, Action: action})
		}
	}
}

func (c *taskbarController) nativeRebuildHandler(generation uint64, handle uintptr) func() {
	return func() {
		if c.generation != generation || c.handle != handle || c.backend == nil {
			return
		}
		backend := c.backend
		op := c.advance()
		state := c.state
		if c.requested.Epoch == state.Epoch && c.requested.Seq > state.Seq {
			state = c.requested
		}
		if state.Epoch != 0 {
			_ = c.applyBackend(state, backend, op, handle, state.Epoch)
		} else {
			_ = backend.clear()
		}
	}
}

func (c *taskbarController) canReportNativeFailure(backend taskbarBackend, op uint64, handle uintptr) bool {
	return c.revision == op+1 && backend == c.backend && handle == c.handle && c.state.Epoch == 0 && c.failure != nil
}

func (c *taskbarController) canAcknowledgeSuperseded(s TaskbarState, backend taskbarBackend, handle uintptr, epoch uint64) bool {
	return backend == c.backend && handle == c.handle && epoch == c.state.Epoch && s.Enabled && c.requested.Enabled && c.requested.Epoch == epoch && c.requested.Seq > s.Seq
}

func (c *taskbarController) applyBackend(s TaskbarState, backend taskbarBackend, op uint64, handle uintptr, epoch uint64) error {
	current := func() bool {
		return op == c.revision && backend == c.backend && handle == c.handle && epoch == c.state.Epoch
	}
	var outcome error
	accepted := false
	complete := func(err error) {
		if !current() {
			outcome = errTaskbarSuperseded
			return
		}
		if err != nil {
			outcome = errors.Join(err, c.revoke())
			// Native cleanup can itself reenter. Cancellation is not a native failure,
			// and a stale completion cannot report or revoke another owner's failure.
			if accepted && !errors.Is(err, errTaskbarSuperseded) && c.canReportNativeFailure(backend, op, handle) {
				c.failure(TaskbarFailure{Epoch: s.Epoch, Seq: s.Seq, Code: "native-failed"})
			}
			return
		}
		c.state = s
	}
	if native, ok := backend.(taskbarCompletionBackend); ok {
		var state *TaskbarState
		if s.Enabled {
			state = &s
		}
		called := false
		err := native.submit(state, func(err error) { called = true; complete(err) })
		if err == errTaskbarQueued {
			accepted = true
			return errTaskbarQueued
		}
		if !called {
			complete(err)
		}
		// An enabled update replaced by a newer accepted enabled update from the
		// same owner still has an acceptance ACK. It never commits the old state.
		// Clear, close, revoke, failed latest work and owner replacement stay errors.
		if outcome == errTaskbarSuperseded && native.accepting() && c.canAcknowledgeSuperseded(s, backend, handle, epoch) {
			return errTaskbarQueued
		}
		return outcome
	}
	var err error
	if s.Enabled {
		err = backend.sync(s)
	} else {
		err = backend.clear()
	}
	complete(err)
	return outcome
}

func (c *taskbarController) revoke() error {
	c.advance()
	c.state = TaskbarState{}
	c.requested = TaskbarState{}
	if c.backend != nil {
		return c.backend.clear()
	}
	return nil
}

func (c *taskbarController) shutdown() error {
	op := c.advance()
	b, handle := c.backend, c.handle
	err := c.revoke()
	if c.revision != op+1 || c.backend != b || c.handle != handle {
		return errors.Join(err, errTaskbarSuperseded)
	}
	c.generation++
	c.backend = nil
	c.handle = 0
	if b != nil {
		return errors.Join(err, b.close())
	}
	return err
}
