package main

import (
	"sync"
	"time"
)

// Only the worker touches the clock. Session state is updated exclusively by the
// serial dispatcher, including the last throttled sample before SDK completion.
type updatesProgressReporter struct {
	mu                        sync.Mutex
	now                       func() time.Time
	send                      func(int64, int64)
	last                      time.Time
	downloaded, total         int64
	sentDownloaded, sentTotal int64
}

func newUpdatesProgressReporter(send func(int64, int64)) *updatesProgressReporter {
	return &updatesProgressReporter{now: time.Now, send: send}
}

func (p *updatesProgressReporter) report(downloaded, total int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if downloaded < 0 || downloaded < p.downloaded {
		return
	}
	p.downloaded, p.total = downloaded, total
	now := p.now()
	if !p.last.IsZero() && now.Sub(p.last) < 100*time.Millisecond && !(total > 0 && downloaded == total) {
		return
	}
	p.publish(now)
}

func (p *updatesProgressReporter) publish(now time.Time) {
	if p.downloaded == p.sentDownloaded && p.total == p.sentTotal {
		return
	}
	p.last = now
	p.sentDownloaded, p.sentTotal = p.downloaded, p.total
	p.send(p.downloaded, p.total)
}

func (p *updatesProgressReporter) finish() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.publish(p.now())
}
