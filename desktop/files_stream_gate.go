package main

import (
	"context"
	"os"
	"sync"

	"github.com/egoist/mygo"
)

// A hold starts before resolving an FD and ends after its FD and request lease
// have actually closed. Ticket cancellation alone is not a reader-drain signal.
type localAudioReadHold struct {
	info   os.FileInfo
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
	server *localAudioServer
}

type localAudioWriteGate struct {
	info os.FileInfo
}

func (a *localAudioServer) beginRead(lease *directoryLease, ref LocalFileRef, ctx context.Context) (*localAudioReadHold, error) {
	var info os.FileInfo
	err := a.state.main(lease.owner, func(parent *mygo.Window) error {
		if err := a.state.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		entry := a.state.fileEntries[ref.FileID]
		if entry == nil || entry.handle != lease.handle || entry.ref != ref {
			return errFilesChanged
		}
		info = entry.info
		return nil
	})
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || ctx.Err() != nil || a.gated(info) {
		return nil, errLocalAudio
	}
	readCtx, cancel := context.WithCancel(ctx)
	hold := &localAudioReadHold{info: info, ctx: readCtx, cancel: cancel, done: make(chan struct{}), server: a}
	if a.readers == nil {
		a.readers = make(map[*localAudioReadHold]struct{})
	}
	a.readers[hold] = struct{}{}
	return hold, nil
}

func (r *localAudioReadHold) finish() {
	if r == nil {
		return
	}
	r.once.Do(func() {
		r.cancel()
		r.server.mu.Lock()
		delete(r.server.readers, r)
		close(r.done)
		r.server.mu.Unlock()
	})
}

// gated requires a.mu. Identity comparison covers other grants and hardlinks.
func (a *localAudioServer) gated(info os.FileInfo) bool {
	for gate := range a.writeGates {
		if os.SameFile(gate.info, info) {
			return true
		}
	}
	return false
}

// quiesce installs the gate before cancelling any old reader. It waits outside
// the actor and keeps the gate installed until the transaction calls release.
func (a *localAudioServer) quiesce(ctx context.Context, info os.FileInfo) (func(), error) {
	if ctx.Err() != nil || info == nil {
		return nil, errLocalAudio
	}
	a.mu.Lock()
	if a.closed || a.gated(info) {
		a.mu.Unlock()
		return nil, errLocalAudio
	}
	gate := &localAudioWriteGate{info: info}
	if a.writeGates == nil {
		a.writeGates = make(map[*localAudioWriteGate]struct{})
	}
	a.writeGates[gate] = struct{}{}
	var readers []*localAudioReadHold
	for reader := range a.readers {
		if os.SameFile(reader.info, info) {
			readers = append(readers, reader)
		}
	}
	var tickets []*localAudioTicket
	for _, ticket := range a.tickets {
		if ticket.info != nil && os.SameFile(ticket.info, info) {
			tickets = append(tickets, ticket)
		}
	}
	a.mu.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() {
			a.mu.Lock()
			delete(a.writeGates, gate)
			a.mu.Unlock()
		})
	}
	for _, ticket := range tickets {
		ticket.cancel()
	}
	for _, reader := range readers {
		reader.cancel()
	}
	wait := func(done <-chan struct{}) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return nil
		}
	}
	for _, reader := range readers {
		if err := wait(reader.done); err != nil {
			release()
			return nil, err
		}
	}
	for _, ticket := range tickets {
		if err := wait(ticket.done); err != nil {
			release()
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	return release, nil
}
