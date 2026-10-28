package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestLocalAudioIdentityGateDrainsHTTPAndAliases(t *testing.T) {
	a, ctx, epoch, ref, data, path := audioFixture(t, "mp3")
	lease, err := a.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if err = os.Link(path, filepath.Join(filepath.Dir(path), "alias.data")); err != nil {
		t.Fatal(err)
	}
	alias, fd, err := a.state.registerLocalFile(lease, "alias.data")
	if err != nil {
		t.Fatal(err)
	}
	fd.Close()
	if err = os.WriteFile(filepath.Join(filepath.Dir(path), "other.data"), data, 0600); err != nil {
		t.Fatal(err)
	}
	other, fd, err := a.state.registerLocalFile(lease, "other.data")
	if err != nil {
		t.Fatal(err)
	}
	fd.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	ticket := audioOpen(t, a, ctx, epoch, ref)
	aliasTicket := audioOpen(t, a, ctx, epoch, *alias)
	otherTicket := audioOpen(t, a, ctx, epoch, *other)
	writer := &audioBlockedWriter{header: make(http.Header), entered: make(chan struct{}), released: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.ServeHTTP(writer, httptest.NewRequest("GET", ticket.URL, nil))
	}()
	audioAwait(t, writer.entered)
	release, err := a.quiesce(context.Background(), info)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	audioAwait(t, done)
	a.mu.Lock()
	readers := len(a.readers)
	gated := a.gated(info)
	a.mu.Unlock()
	if readers != 0 || !gated {
		t.Fatal("drain returned before reader cleanup or released its write gate")
	}
	if result := audioRequest(a, ticket, "GET", ""); result.Code != 404 {
		t.Fatal("source ticket remained live")
	}
	if result := audioRequest(a, aliasTicket, "GET", ""); result.Code != 404 {
		t.Fatal("hardlink alias ticket remained live")
	}
	if _, err = a.open(ctx, epoch, *alias); err == nil {
		t.Fatal("hardlink alias bypassed the active gate")
	}
	if result := audioRequest(a, otherTicket, "GET", ""); result.Code != 200 {
		t.Fatal("unrelated file was cancelled")
	}
	release()
	release()
	reopened := audioOpen(t, a, ctx, epoch, *alias)
	if result := audioRequest(a, reopened, "GET", ""); result.Code != 200 {
		t.Fatal("idempotent gate release failed")
	}
}

func TestLocalAudioIdentityGatePendingOpen(t *testing.T) {
	for _, cancelDrain := range []bool{false, true} {
		name := "drain"
		if cancelDrain {
			name = "cancel"
		}
		t.Run(name, func(t *testing.T) {
			a, ctx, epoch, ref, _, path := audioFixture(t, "flac")
			a.host = ""
			entered, proceed := make(chan struct{}), make(chan struct{})
			var proceedOnce sync.Once
			releaseListen := func() { proceedOnce.Do(func() { close(proceed) }) }
			t.Cleanup(releaseListen)
			listener := &audioFakeListener{closed: make(chan struct{})}
			a.listen = func(string, string) (net.Listener, error) {
				close(entered)
				<-proceed
				return listener, nil
			}
			opened := make(chan error, 1)
			go func() {
				ticket, err := a.open(ctx, epoch, ref)
				if ticket.URL != "" {
					t.Error("pending open published a ticket after the write gate")
				}
				opened <- err
			}()
			audioAwait(t, entered)
			a.mu.Lock()
			var hold *localAudioReadHold
			for reader := range a.readers {
				hold = reader
			}
			a.mu.Unlock()
			if hold == nil {
				t.Fatal("pending open was not registered as a reader")
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			gateCtx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type result struct {
				release func()
				err     error
			}
			gated := make(chan result, 1)
			go func() {
				release, err := a.quiesce(gateCtx, info)
				gated <- result{release, err}
			}()
			audioAwait(t, hold.ctx.Done())
			select {
			case <-gated:
				t.Fatal("drain accepted an open which had not actually returned")
			default:
			}
			if _, err = a.open(ctx, epoch, ref); err == nil {
				t.Fatal("new open bypassed the identity gate")
			}
			if cancelDrain {
				cancel()
				select {
				case got := <-gated:
					if got.err == nil || got.release != nil {
						t.Fatal("cancelled drain returned a false success")
					}
				case <-time.After(5 * time.Second):
					t.Fatal("cancelled drain did not finish")
				}
			}
			releaseListen()
			select {
			case err := <-opened:
				if err == nil {
					t.Fatal("pending open succeeded")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("pending open did not finish")
			}
			audioAwait(t, listener.closed)
			if !cancelDrain {
				select {
				case got := <-gated:
					if got.err != nil || got.release == nil {
						t.Fatal("drain did not observe actual reader exit")
					}
					got.release()
				case <-time.After(5 * time.Second):
					t.Fatal("drain did not finish")
				}
			}
			a.mu.Lock()
			count := len(a.readers) + len(a.writeGates) + len(a.tickets)
			a.mu.Unlock()
			if count != 0 {
				t.Fatal("reader, gate or ticket leaked")
			}
		})
	}
}

func TestLocalAudioGateIncludesRetiringTicket(t *testing.T) {
	a, ctx, epoch, ref, _, path := audioFixture(t, "mp3")
	ticket := audioOpen(t, a, ctx, epoch, ref)
	a.mu.Lock()
	entry := a.tickets[ticket.TicketID]
	a.mu.Unlock()
	entered, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	resume := func() { once.Do(func() { close(proceed) }) }
	t.Cleanup(resume)
	stop := entry.lease.stopGrant
	entry.lease.stopGrant = func() bool {
		close(entered)
		<-proceed
		return stop()
	}
	if err := a.closeTicket(ctx, epoch, ticket.TicketID); err != nil {
		t.Fatal(err)
	}
	audioAwait(t, entered)
	a.mu.Lock()
	retained := a.tickets[ticket.TicketID] == entry
	a.mu.Unlock()
	if !retained {
		resume()
		audioAwait(t, entry.done)
		t.Fatal("ticket left the registry before its lease cleanup completed")
	}
	lease, err := a.state.acquireDirectory(ctx, epoch, ref.GrantToken)
	if err != nil {
		t.Fatal(err)
	}
	hold, err := a.beginRead(lease, ref, lease.Context())
	if err != nil {
		lease.Release()
		t.Fatal(err)
	}
	defer func() { lease.Release(); hold.finish() }()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	gateCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	drained := make(chan error, 1)
	go func() {
		release, err := a.quiesce(gateCtx, info)
		if release != nil {
			release()
		}
		drained <- err
	}()
	audioAwait(t, hold.ctx.Done())
	lease.Release()
	hold.finish()
	cancel()
	select {
	case err := <-drained:
		if err == nil {
			t.Fatal("drain succeeded with a ticket lease still being cleaned up")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("drain did not respect cancellation")
	}
	resume()
	audioAwait(t, entry.done)
	release, err := a.quiesce(context.Background(), info)
	if err != nil {
		t.Fatal(err)
	}
	release()
}
