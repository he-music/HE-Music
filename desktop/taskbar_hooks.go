package main

import "errors"

// Hook handoff owns at most the previous observer and its replacement. Failed
// removals remain rooted until removal succeeds or HWND destruction retires them.
type taskbarHookOwner interface {
	removeHook() error
	hookDestroyed()
}

type taskbarHookHandoff struct {
	retained   [2]taskbarHookOwner
	busy, dead bool
}

func (h *taskbarHookHandoff) replace(previous, next taskbarHookOwner) error {
	if h.busy || h.dead || h.retained[0] != nil || h.retained[1] != nil {
		return errors.New("taskbar hook handoff unavailable")
	}
	h.busy = true
	defer func() { h.busy = false }()
	// Track both before calling user32: callbacks may observe HWND destruction.
	h.retained = [2]taskbarHookOwner{previous, next}
	err := previous.removeHook()
	if err == nil {
		h.retained = [2]taskbarHookOwner{}
		if h.dead {
			return errors.New("taskbar hook window destroyed")
		}
		return nil
	}
	var rollback error
	if h.retained[1] != nil {
		rollback = next.removeHook()
		if rollback == nil {
			h.retained[1] = nil
		}
	}
	return errors.Join(err, rollback)
}

// retry runs before installing another native hook, and attempts each remaining
// removal independently. A failed retry admits no new installation, bounding the
// live native subclasses and Go roots to the two slots above.
func (h *taskbarHookHandoff) retry() error { return h.retryKeeping(nil) }

func (h *taskbarHookHandoff) retryKeeping(observer taskbarHookOwner) error {
	if h.busy || h.dead {
		return errors.New("taskbar hook cleanup unavailable")
	}
	h.busy = true
	defer func() { h.busy = false }()
	var errs []error
	for i, hook := range h.retained {
		if h.dead {
			break
		}
		if hook == nil || hook == observer {
			continue
		}
		if err := hook.removeHook(); err != nil {
			errs = append(errs, err)
		} else {
			h.retained[i] = nil
		}
	}
	if h.dead {
		errs = append(errs, errors.New("taskbar hook window destroyed"))
	}
	if len(errs) == 0 && observer != nil {
		// The live record resumes ownership of its observer. Do not remove its
		// native hook until a replacement has actually been installed.
		for i, hook := range h.retained {
			if hook == observer {
				h.retained[i] = nil
			}
		}
	}
	return errors.Join(errs...)
}

// Called only at WM_NCDESTROY. Windows now owns final native subclass retirement;
// hookDestroyed drops Go tracking even if an explicit native remove failed.
func (h *taskbarHookHandoff) destroyed() {
	h.dead = true
	retained := h.retained
	h.retained = [2]taskbarHookOwner{}
	for _, hook := range retained {
		if hook != nil {
			hook.hookDestroyed()
		}
	}
}

// The numeric HWND may already refer to a new cookie/record. Retire old roots
// unconditionally, but only delete the registry entry belonging to this record.
func taskbarDestroyHookRecord[T comparable](hooks *taskbarHookHandoff, records map[uintptr]T, hwnd uintptr, record T) {
	hooks.destroyed()
	if records[hwnd] == record {
		delete(records, hwnd)
	}
}
