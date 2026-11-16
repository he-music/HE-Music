// Package schemestream holds the parts of streaming custom scheme
// responses to WebView2 that do not need Windows, so that they are tested
// everywhere: Pipe, which carries a response's body from the goroutine of
// its handler to the reads of the webview with bounded memory, and
// ClampRange, which narrows the open ranges media elements ask for.
package schemestream

import (
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrReleased is what writes return once the reader no longer wants the
// body: the webview released the stream, or the response was answered
// another way.
var ErrReleased = errors.New("mygo: the webview no longer reads the response")

// ErrTimeout is what Read returns when it waited the time it was given
// and found nothing to read.
var ErrTimeout = errors.New("mygo: no data to read in time")

// A Pipe carries a body from one writer, the handler's goroutine, to one
// reader, the webview. Write waits while the pipe holds limit bytes or
// more that were not read, so a handler faster than the reader does not
// pile up memory, and Read waits for as many bytes as it asks for, or the
// end of the body, so that a short read means the end as with a stream in
// memory.
type Pipe struct {
	mu      sync.Mutex
	changed chan struct{} // closed and replaced on every change
	buf     []byte        // written, not yet read
	limit   int
	// want is how many bytes a waiting Read asks for: writes go on until
	// the pipe holds that many, even past limit, so that Read gets them.
	want     int
	closed   bool  // the writer is done: the body ends after buf
	err      error // the body broke off: reads fail
	released bool  // the reader is gone: writes fail
	onFull   func()
	full     bool // onFull was called
}

// NewPipe returns a pipe holding up to about limit bytes. onFull, if not
// nil, is called once, on the writer's goroutine, the first time a Write
// waits: then no reader has taken the body yet, or it reads slower than
// the writer writes.
func NewPipe(limit int, onFull func()) *Pipe {
	return &Pipe{changed: make(chan struct{}), limit: limit, onFull: onFull}
}

func (p *Pipe) broadcast() {
	close(p.changed)
	p.changed = make(chan struct{})
}

// wait releases the lock until the pipe changes or timeout fires, which
// it reports as false.
func (p *Pipe) wait(timeout <-chan time.Time) bool {
	ch := p.changed
	p.mu.Unlock()
	defer p.mu.Lock()
	select {
	case <-ch:
		return true
	case <-timeout:
		return false
	}
}

// Write appends b, after waiting while the pipe is full. It fails once
// the reader is gone or the body broke off.
func (p *Pipe) Write(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for {
		switch {
		case p.released:
			return ErrReleased
		case p.err != nil:
			return p.err
		case p.closed:
			return io.ErrClosedPipe
		}
		if len(p.buf) < max(p.limit, p.want) {
			break
		}
		if !p.full && p.onFull != nil {
			p.full = true
			p.mu.Unlock()
			p.onFull()
			p.mu.Lock()
			continue
		}
		p.wait(nil)
	}
	p.buf = append(p.buf, b...)
	p.broadcast()
	return nil
}

// Close ends the body after what was written.
func (p *Pipe) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		p.closed = true
		p.broadcast()
	}
}

// Fail breaks the body off: reads return err once they took what was
// written, and writes fail.
func (p *Pipe) Fail(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err == nil {
		p.err = err
		p.broadcast()
	}
}

// Release tells the pipe that nothing reads it any more: writes fail from
// now on, and what they wrote is dropped.
func (p *Pipe) Release() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.released {
		p.released = true
		p.buf = nil
		p.broadcast()
	}
}

// Take returns what was written and not read, and empties the pipe, for
// a body that ended before anything read it.
func (p *Pipe) Take() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.buf
	p.buf = nil
	p.broadcast()
	return b
}

// Read fills b, waiting until the pipe holds len(b) bytes or the body
// ended. It returns fewer bytes than len(b) with io.EOF at the end of the
// body, and the error of Fail, or ErrReleased, once the body broke off and
// was read up to there. With timeout > 0 it waits at most that long: then
// it returns what it has, and ErrTimeout if that is nothing.
func (p *Pipe) Read(b []byte, timeout time.Duration) (int, error) {
	var deadline <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		deadline = t.C
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.buf) < len(b) && !p.closed && p.err == nil && !p.released {
		p.want = len(b)
		p.broadcast() // a writer waiting on a full pipe may write more now
		if !p.wait(deadline) {
			break
		}
	}
	p.want = 0
	n := copy(b, p.buf)
	p.buf = p.buf[n:]
	if len(p.buf) == 0 {
		p.buf = nil // let the chunks go
	}
	if n > 0 {
		p.broadcast()
	}
	switch {
	case n == len(b):
		return n, nil
	case p.released:
		return n, ErrReleased
	case p.err != nil:
		return n, p.err
	case p.closed:
		return n, io.EOF
	case n == 0:
		return 0, ErrTimeout
	}
	return n, nil
}

// ClampRange narrows a Range header asking for the rest of a resource
// from a byte on, "bytes=X-", to at most n bytes, "bytes=X-(X+n-1)", and
// returns other headers as they are. A media element asking an open range
// takes a shorter answer (206 with its Content-Range) and asks for what
// follows when it needs it, as it would over HTTP.
func ClampRange(h string, n int64) string {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || n <= 0 {
		return h
	}
	first, last, ok := strings.Cut(spec, "-")
	if !ok || last != "" || first == "" || first[0] < '0' || first[0] > '9' {
		return h
	}
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start < 0 || start > (1<<63-1)-n {
		return h
	}
	return "bytes=" + first + "-" + strconv.FormatInt(start+n-1, 10)
}
