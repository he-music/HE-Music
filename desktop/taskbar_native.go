package main

import "errors"

// Internal queued result: the RPC provider maps this to acceptance, while the
// controller commits only on completion and emits a failure for accepted work.
var errTaskbarQueued = errors.New("taskbar operation queued")

const taskbarDrainBudget = 32

type taskbarNativeRequest struct {
	revision  uint64
	state     TaskbarState
	done      func(error)
	completed bool
	err       error
}

// All methods run on the UI thread. running covers the entire drain, including
// completion callbacks, so neither native calls nor callbacks recursively drain.
type taskbarNativeExecutor struct {
	*taskbarNativeWindow
	invoke                       func(int, TaskbarState, bool) error
	release                      func() error
	post                         func() error
	report                       func(error)
	active, closed, running      bool
	deferredClear, deferredClose bool
	revision                     uint64
	pending, clearing, closing   *taskbarNativeRequest
	posted                       bool
}

func (e *taskbarNativeExecutor) ensureWindow() {
	if e.taskbarNativeWindow == nil {
		e.taskbarNativeWindow = &taskbarNativeWindow{}
	}
}
func (e *taskbarNativeExecutor) accepting() bool { return !e.closed && !e.deferredClose }
func (e *taskbarNativeExecutor) complete(r *taskbarNativeRequest, err error) {
	if r == nil || r.completed {
		return
	}
	r.completed, r.err = true, err
	if r.done != nil {
		r.done(err)
	}
}
func (e *taskbarNativeExecutor) sync(s TaskbarState) error { return e.submit(&s, nil) }
func (e *taskbarNativeExecutor) clear() error              { return e.submit(nil, nil) }

// nil means completed; Queued means accepted, with completion still outstanding.
// Native state and command gates must never be inferred from acceptance alone.
func (e *taskbarNativeExecutor) submit(s *TaskbarState, done func(error)) error {
	e.ensureWindow()
	if !e.accepting() {
		return errors.New("taskbar native owner retired")
	}
	e.revision++
	r := &taskbarNativeRequest{revision: e.revision, done: done}
	e.active = false
	// Hold the drain lock while completing displaced requests, too.
	owned := !e.running
	e.running = true
	old := e.pending
	e.pending = nil
	if s == nil {
		previous := e.clearing
		e.clearing, e.deferredClear = r, true
		e.complete(previous, errTaskbarSuperseded)
	} else {
		r.state = *s
		e.pending = r
	}
	e.complete(old, errTaskbarSuperseded)
	if !owned {
		return errTaskbarQueued
	}
	e.running = false
	e.drain()
	if !r.completed {
		return errTaskbarQueued
	}
	return r.err
}

func (e *taskbarNativeExecutor) close() error {
	e.ensureWindow()
	e.active = false
	if e.closed {
		return nil
	}
	if e.deferredClose {
		return errTaskbarQueued
	}
	e.revision++
	r := &taskbarNativeRequest{revision: e.revision}
	e.closing, e.deferredClose = r, true
	owned := !e.running
	e.running = true
	old := e.pending
	e.pending = nil
	e.complete(old, errTaskbarSuperseded)
	if !owned {
		return errTaskbarQueued
	}
	e.running = false
	e.drain()
	if !r.completed {
		return errTaskbarQueued
	}
	return r.err
}

func (e *taskbarNativeExecutor) current(r *taskbarNativeRequest) bool {
	return e.revision == r.revision && !e.deferredClose && !e.closed
}

func (e *taskbarNativeExecutor) apply(r *taskbarNativeRequest) error {
	method := 16
	if !e.added {
		method = 15
	}
	explorer := e.explorer
	err := e.invoke(method, r.state, false)
	// HRESULT resource facts survive logical cancellation. Explorer recreation is
	// the only event that invalidates an already-installed button collection.
	if err == nil && method == 15 && explorer == e.explorer {
		e.added = true
	}
	if err != nil {
		return err
	}
	if !e.current(r) {
		return errTaskbarSuperseded
	}
	if err = e.invoke(10, r.state, false); err != nil {
		return err
	}
	if !e.current(r) {
		return errTaskbarSuperseded
	}
	if r.state.DurationMs > 0 {
		if err = e.invoke(9, r.state, false); err != nil {
			return err
		}
		if !e.current(r) {
			return errTaskbarSuperseded
		}
	}
	e.active = true
	return nil
}

func (e *taskbarNativeExecutor) hide() error {
	e.active = false
	err := e.invoke(10, TaskbarState{}, true)
	if e.added {
		err = errors.Join(err, e.invoke(16, TaskbarState{}, true))
	}
	return err
}

func (e *taskbarNativeExecutor) retire() error {
	err := e.hide()
	// Release may pump messages as well. deferredClose remains set until it returns.
	if e.release != nil {
		err = errors.Join(err, e.release())
	}
	e.closed, e.active = true, false
	e.deferredClose, e.deferredClear, e.posted = false, false, false
	pending, clear := e.pending, e.clearing
	e.pending, e.clearing = nil, nil
	e.complete(pending, errTaskbarSuperseded)
	e.complete(clear, errTaskbarSuperseded)
	return err
}

func (e *taskbarNativeExecutor) drain() {
	if e.running || e.closed {
		return
	}
	e.running = true
	defer func() { e.running = false }()
	for count := 0; ; count++ {
		if e.deferredClose {
			r := e.closing
			e.closing = nil
			err := e.retire()
			e.complete(r, err)
			if err != nil && e.report != nil {
				e.report(err)
			}
			return
		}
		if e.clearing == nil && e.pending == nil {
			return
		}
		if count >= taskbarDrainBudget {
			if e.posted {
				return
			}
			e.posted = true
			var err error
			if e.post == nil {
				err = errors.New("taskbar drain scheduler unavailable")
			} else {
				err = e.post()
			}
			if err != nil {
				// A failed post cannot leave accepted work stranded or silently succeed.
				e.deferredClose = true
				pending, clear := e.pending, e.clearing
				e.pending, e.clearing = nil, nil
				e.complete(pending, err)
				e.complete(clear, err)
				cleanup := e.retire()
				if e.report != nil {
					e.report(errors.Join(err, cleanup))
				}
			}
			return
		}
		if e.clearing != nil {
			r := e.clearing
			e.clearing, e.deferredClear = nil, false
			err := e.hide()
			if err == nil && !e.current(r) {
				err = errTaskbarSuperseded
			}
			e.complete(r, err)
			if err != nil && !errors.Is(err, errTaskbarSuperseded) && e.report != nil {
				e.report(err)
			}
		} else {
			r := e.pending
			e.pending = nil
			e.complete(r, e.apply(r))
		}
	}
}
func (e *taskbarNativeExecutor) resume() { e.posted = false; e.drain() }
func (e *taskbarNativeExecutor) explorerCreated() {
	e.ensureWindow()
	e.explorer++
	e.revision++
	e.added, e.active = false, false
}
