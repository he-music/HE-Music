package main

import "context"

// UpdatesState never contains feed URLs, local paths, or SDK installation handles.
// Phase is idle/checking/available/no-update/unavailable/installing/installed/error/inactive.
// Installed means replacement completed; the running process still uses its old version.
type UpdatesState struct {
	Epoch             uint64 `json:"epoch"`
	OperationRevision uint64 `json:"operationRevision"`
	StateRevision     uint64 `json:"stateRevision"`
	Phase             string `json:"phase"`
	Code              string `json:"code"`
	Version           string `json:"version"`
	Notes             string `json:"notes"`
	Date              string `json:"date"`
	InstallBusy       bool   `json:"installBusy"`
}

// UpdatesEvent acknowledges queued commands. RequestID is caller correlation only;
// epoch + operationRevision + stateRevision determine freshness, including queued events.
// Code is a stable command rejection code, never a raw SDK/filesystem error.
type UpdatesEvent struct {
	RequestID uint64       `json:"requestId"`
	Code      string       `json:"code"`
	State     UpdatesState `json:"state"`
}

type updatesCandidate interface {
	metadata() (version, notes, date string)
	install(context.Context) error
}

type updatesDriver interface {
	check(context.Context) (updatesCandidate, error)
}

// Updates methods only enqueue short authorization/state work and return immediately.
// RPC completion means queued, not authorized/successful. Subscribe to desktop:updates
// before Begin and wait for its event before issuing commands with the returned epoch.
// No background checker or installation runs until explicitly requested.
type Updates struct {
	session updatesSession
	post    func(func())
	valid   func(context.Context) bool
	emit    func(context.Context, UpdatesEvent) error
}

func (u *Updates) Begin(ctx context.Context, requestID uint64) {
	u.command(ctx, requestID, func() string { return u.session.begin(ctx) })
}

func (u *Updates) GetState(ctx context.Context, requestID, epoch uint64) {
	u.command(ctx, requestID, func() string { return u.session.owns(ctx, epoch) })
}

func (u *Updates) Check(ctx context.Context, requestID, epoch, revision uint64) {
	u.command(ctx, requestID, func() string { return u.session.check(ctx, epoch, revision, requestID) })
}

// Download is deliberately unsupported: the pinned SDK exposes only a combined
// signed download + replacement operation. This method never starts that operation.
func (u *Updates) Download(ctx context.Context, requestID, epoch, revision uint64) {
	u.command(ctx, requestID, func() string {
		if code := u.session.owns(ctx, epoch); code != "" {
			return code
		}
		return "unsupported"
	})
}

// Install applies the current candidate using SDK signature verification. There is
// no restart here and no promise that cancellation can prevent disk replacement.
func (u *Updates) Install(ctx context.Context, requestID, epoch, revision uint64) {
	u.command(ctx, requestID, func() string { return u.session.install(ctx, epoch, revision, requestID) })
}

func (u *Updates) Teardown(ctx context.Context, requestID, epoch uint64) {
	u.command(ctx, requestID, func() string {
		if code := u.session.owns(ctx, epoch); code != "" {
			return code
		}
		u.session.revoke()
		return ""
	})
}

func (u *Updates) command(ctx context.Context, requestID uint64, action func() string) {
	u.post(func() {
		// Invalid pages receive no state or event. Lifecycle/CallerPage access is
		// confined to this dispatcher (the native main thread in production).
		if ctx.Err() != nil || !u.valid(ctx) {
			return
		}
		code := action()
		u.publish(ctx, requestID, code)
	})
}

func (u *Updates) publish(ctx context.Context, requestID uint64, code string) {
	if ctx.Err() != nil || !u.valid(ctx) {
		return
	}
	if err := u.emit(ctx, UpdatesEvent{RequestID: requestID, Code: code, State: u.session.snapshot()}); err != nil {
		u.session.revoke()
	}
}

// revoke must be called on the same dispatcher as commands, by the parent's
// lifecycle revoke/quit/cleanup hooks. It never waits for a worker or releases
// the service-wide installation fence. Owner cancellation also invokes it.
func (u *Updates) revoke() { u.session.revoke() }
