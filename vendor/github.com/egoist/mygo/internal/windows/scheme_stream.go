//go:build windows && (amd64 || arm64)

package windows

import (
	"errors"
	"io"
	"log"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/egoist/mygo/internal/schemestream"
)

// A bodyStream is the IStream through which WebView2 reads a custom
// scheme response that streams (schemeResponse), taking it from a
// schemestream.Pipe the handler's goroutine writes into.
//
// WebView2 reads a response's stream on a background thread of its own
// in the app's process, until a read comes back short or fails, and
// releases it then (MicrosoftEdge/WebView2Feedback#2513). The stream is
// agile: it says so (IAgileObject) and marshals itself as the
// free-threaded marshaler does, so WebView2 calls it on that thread
// rather than through a proxy to the UI thread, which created it. Read
// may then wait for the handler, which the UI thread must never do: a
// Read that does come on the UI thread waits at most uiReadWait, and the
// response breaks off if the handler gave nothing by then.
//
// The final Release cancels the request's context, so that a handler
// whose response WebView2 no longer reads stops writing.
type bodyStream struct {
	vtbl   *[14]uintptr
	refs   int32
	pipe   *schemestream.Pipe
	size   int64   // the body's length for Stat, -1 when unknown
	pos    int64   // bytes read, for Seek
	ftm    uintptr // the free-threaded marshaler aggregated, its inner IUnknown
	cancel func()
}

var (
	bodyStreamVtbl [14]uintptr
	bodyStreamOnce sync.Once
	bodyStreamsMu  sync.Mutex
	bodyStreams    = map[uintptr]*bodyStream{}

	iidISequentialStream = guid("0c733a30-2a1c-11ce-ade5-00aa0044773a")
	iidIStream           = guid("0000000c-0000-0000-c000-000000000046")

	procCoCreateFreeThreadedMarshaler = ole32.NewProc("CoCreateFreeThreadedMarshaler")

	errUIThreadRead = errors.New("mygo: WebView2 waited for a custom scheme response on the UI thread")
	uiReadWarn      sync.Once
)

// uiReadWait is how long a Read on the UI thread waits for the handler.
const uiReadWait = time.Second

// onUIThread reports whether the calling thread is the UI thread; tests
// replace it.
var onUIThread = func() bool { return currentThreadID() == mainThreadID }

const (
	stgEInvalidFunction = 0x80030001
	stgEAccessDenied    = 0x80030005
	stgEReadFault       = 0x8003001e
	eUnexpected         = 0x8000ffff
	stgtyStream         = 2
	streamSeekSet       = 0
	streamSeekCur       = 1
)

// The callbacks are made once, the first time a response streams: apps
// that never stream one don't spend them.
func initBodyStreamVtbl() {
	notImpl := syscall.NewCallback(func(this, a, b, c uintptr) uintptr { return eNotImpl })
	bodyStreamVtbl = [14]uintptr{
		syscall.NewCallback(bodyStreamQueryInterface),
		syscall.NewCallback(func(this uintptr) uintptr { return uintptr(bodyStreamRef(this, 1)) }),
		syscall.NewCallback(func(this uintptr) uintptr { return uintptr(bodyStreamRef(this, -1)) }),
		syscall.NewCallback(bodyStreamRead),
		syscall.NewCallback(func(this, pv, cb, written uintptr) uintptr { return stgEAccessDenied }), // Write
		syscall.NewCallback(bodyStreamSeek),
		notImpl,                                                               // SetSize
		notImpl,                                                               // CopyTo
		syscall.NewCallback(func(this, flags uintptr) uintptr { return sOK }), // Commit: nothing to commit
		notImpl, // Revert
		notImpl, // LockRegion
		notImpl, // UnlockRegion
		syscall.NewCallback(bodyStreamStat),
		notImpl, // Clone
	}
}

// newBodyStream returns a stream reading pipe, holding one reference,
// which the caller releases once it handed the stream to WebView2. size is
// the body's length, -1 if unknown. cancel runs on the final Release.
func newBodyStream(pipe *schemestream.Pipe, size int64, cancel func()) uintptr {
	bodyStreamOnce.Do(initBodyStreamVtbl)
	s := &bodyStream{vtbl: &bodyStreamVtbl, refs: 1, pipe: pipe, size: size, cancel: cancel}
	p := uintptr(unsafe.Pointer(s))
	bodyStreamsMu.Lock()
	bodyStreams[p] = s
	bodyStreamsMu.Unlock()
	// Aggregated, the marshaler's IMarshal counts its references on s.
	var ftm uintptr
	if hr, _, _ := procCoCreateFreeThreadedMarshaler.Call(p, uintptr(unsafe.Pointer(&ftm))); !failed(hr) {
		s.ftm = ftm
	}
	return p
}

func lookupBodyStream(this uintptr) *bodyStream {
	bodyStreamsMu.Lock()
	defer bodyStreamsMu.Unlock()
	return bodyStreams[this]
}

func bodyStreamRef(this uintptr, delta int32) int32 {
	bodyStreamsMu.Lock()
	s := bodyStreams[this]
	if s == nil {
		bodyStreamsMu.Unlock()
		return 0
	}
	s.refs += delta
	refs := s.refs
	if refs <= 0 {
		delete(bodyStreams, this)
	}
	bodyStreamsMu.Unlock()
	if refs <= 0 {
		// WebView2 is done with the body, read or not: the handler's
		// writes fail and its context ends.
		s.pipe.Release()
		if s.cancel != nil {
			s.cancel()
		}
		release(s.ftm)
		return 0
	}
	return refs
}

func bodyStreamQueryInterface(this, riid, out uintptr) uintptr {
	*(*uintptr)(native(out)) = 0
	s := lookupBodyStream(this)
	if s == nil {
		return eUnexpected
	}
	switch *(*GUID)(native(riid)) {
	case iidIUnknown, iidISequentialStream, iidIStream, iidIAgileObject:
		*(*uintptr)(native(out)) = this
		bodyStreamRef(this, 1)
		return sOK
	case iidIMarshal:
		if s.ftm != 0 {
			return comCall(s.ftm, 0, riid, out) // the marshaler's IMarshal, which counts on s
		}
	}
	return eNoInterface
}

// bodyStreamRead is ISequentialStream::Read: it fills the buffer, waiting
// for the handler, and comes back short only at the end of the body, with
// S_FALSE, as a stream in memory does. A body that broke off fails.
func bodyStreamRead(this, pv, cb, pcbRead uintptr) uintptr {
	if pcbRead != 0 {
		*(*uint32)(native(pcbRead)) = 0
	}
	s := lookupBodyStream(this)
	if s == nil {
		return eUnexpected
	}
	n := int(uint32(cb)) // a ULONG: the register's upper half is undefined
	var buf []byte
	if n > 0 {
		buf = unsafe.Slice((*byte)(native(pv)), n)
	}
	var wait time.Duration
	if onUIThread() {
		wait = uiReadWait
	}
	k, err := s.pipe.Read(buf, wait)
	s.pos += int64(k)
	if pcbRead != 0 {
		*(*uint32)(native(pcbRead)) = uint32(k)
	}
	switch {
	case err == nil:
		return sOK
	case err == io.EOF:
		return sFalse
	case err == schemestream.ErrTimeout:
		uiReadWarn.Do(func() {
			log.Print("mygo: WebView2 reads custom scheme responses on the UI thread, which must not wait for a handler: a response it waited for broke off")
		})
		s.pipe.Fail(errUIThreadRead)
		if s.cancel != nil {
			s.cancel()
		}
		if k > 0 {
			return sOK
		}
		return stgEReadFault
	case k > 0:
		return sOK // the failure comes with the next read
	}
	return stgEReadFault
}

// bodyStreamSeek is IStream::Seek. The body can't be sought: only the
// moves that stay where the stream is succeed, which tell its position.
func bodyStreamSeek(this, move, origin, newPos uintptr) uintptr {
	s := lookupBodyStream(this)
	if s == nil {
		return eUnexpected
	}
	switch {
	case int64(move) == 0 && uint32(origin) == streamSeekCur,
		int64(move) == s.pos && uint32(origin) == streamSeekSet:
	default:
		return stgEInvalidFunction
	}
	if newPos != 0 {
		*(*uint64)(native(newPos)) = uint64(s.pos)
	}
	return sOK
}

// statstg is STATSTG.
type statstg struct {
	name                 uintptr
	typ                  uint32
	size                 uint64
	mtime, ctime, atime  [2]uint32
	mode, locksSupported uint32
	clsid                GUID
	stateBits, reserved  uint32
}

// bodyStreamStat is IStream::Stat, which knows the body's length only
// from its Content-Length.
func bodyStreamStat(this, pstatstg, flags uintptr) uintptr {
	s := lookupBodyStream(this)
	if s == nil || pstatstg == 0 {
		return eUnexpected
	}
	if s.size < 0 {
		return eNotImpl
	}
	*(*statstg)(native(pstatstg)) = statstg{typ: stgtyStream, size: uint64(s.size)}
	return sOK
}
