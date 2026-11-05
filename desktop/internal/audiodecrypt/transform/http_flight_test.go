// 与后端 pkg/um/soda/http_flight_test.go 同步的并发回归测试。
package transform

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"testing/synctest"
)

type flightRoundTripFunc func(*http.Request) (*http.Response, error)

func (f flightRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAudioFlightCancellation(t *testing.T) {
	for _, test := range []struct {
		name        string
		cancelOwner bool
	}{{"owner retries for waiter", true}, {"waiter leaves owner running", false}} {
		t.Run(test.name, func(t *testing.T) {
			file, _, auth := encryptedFixture(t)
			expected, err := DecryptAudio(file, auth)
			if err != nil {
				t.Fatal(err)
			}
			synctest.Test(t, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				var downloads atomic.Int32
				client := &http.Client{Transport: flightRoundTripFunc(func(r *http.Request) (*http.Response, error) {
					if downloads.Add(1) == 1 {
						close(started)
						if test.cancelOwner {
							<-r.Context().Done()
							return nil, r.Context().Err()
						}
						<-release
					}
					return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(file)), ContentLength: int64(len(file))}, nil
				})}
				server, err := NewAudioServer(client, AudioOptions{MaxRequests: 2})
				if err != nil {
					t.Fatal(err)
				}
				type result struct {
					data []byte
					err  error
				}
				ownerResult, waiterResult := make(chan result, 1), make(chan result, 1)
				owner, cancelOwner := context.WithCancel(context.Background())
				defer cancelOwner()
				waiter, cancelWaiter := context.WithCancel(context.Background())
				defer cancelWaiter()
				load := func(ctx context.Context, results chan<- result) {
					data, err := server.load(ctx, [32]byte{}, "http://audio.example/song", auth)
					results <- result{data, err}
				}
				go load(owner, ownerResult)
				<-started
				go load(waiter, waiterResult)
				synctest.Wait()
				var success result
				if test.cancelOwner {
					cancelOwner()
					if got := <-ownerResult; !errors.Is(got.err, context.Canceled) {
						t.Fatalf("owner error = %v", got.err)
					}
					success = <-waiterResult
					if downloads.Load() != 2 {
						t.Fatal("waiter did not restart the canceled flight")
					}
				} else {
					cancelWaiter()
					if got := <-waiterResult; !errors.Is(got.err, context.Canceled) {
						t.Fatalf("waiter error = %v", got.err)
					}
					close(release)
					success = <-ownerResult
					if downloads.Load() != 1 {
						t.Fatal("canceling the waiter restarted the download")
					}
				}
				if success.err != nil || !bytes.Equal(success.data, expected) {
					t.Fatalf("completed flight: bytes=%d error=%v", len(success.data), success.err)
				}
				if len(server.flights) != 0 || len(server.decode) != 0 {
					t.Fatal("flight or decode slot was not released")
				}
			})
		})
	}
}

func TestAudioFlightPanicReleasesWaiters(t *testing.T) {
	_, _, auth := encryptedFixture(t)
	var server *AudioServer
	var flight *audioFlight
	client := &http.Client{Transport: flightRoundTripFunc(func(*http.Request) (*http.Response, error) {
		flight = server.flights[[32]byte{}]
		panic("upstream interrupted")
	})}
	var err error
	server, err = NewAudioServer(client, AudioOptions{MaxRequests: 1})
	if err != nil {
		t.Fatal(err)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected upstream panic")
			}
		}()
		_, _ = server.load(context.Background(), [32]byte{}, "http://audio.example/song", auth)
	}()
	if flight == nil || len(server.flights) != 0 || len(server.decode) != 0 {
		t.Fatal("panicking flight was not released")
	}
	select {
	case <-flight.done:
		if flight.err == nil {
			t.Fatal("interrupted flight did not publish an error")
		}
	default:
		t.Fatal("waiters were not released after panic")
	}
}
