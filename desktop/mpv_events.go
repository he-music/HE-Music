package main

import (
	"context"
	"sync"
	"sync/atomic"
)

// 事件队列只复制 Go 值。发送线程不持有会话锁，主线程回调也不获取会话锁，
// 因而页面撤销不可能与 RunOnMain 互相等待。进度只保留最后一份未发送快照。
type mpvEventQueue struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	pending []MpvEvent
	wake    chan struct{}
	session atomic.Uint64
}

func newMpvEventQueue(ctx context.Context, dispatch func(MpvEvent)) *mpvEventQueue {
	runContext, cancel := context.WithCancel(ctx)
	queue := &mpvEventQueue{ctx: runContext, cancel: cancel, wake: make(chan struct{}, 1)}
	go queue.run(dispatch)
	return queue
}

func (queue *mpvEventQueue) push(event MpvEvent) {
	if queue.ctx.Err() != nil {
		return
	}
	queue.session.Store(event.Snapshot.Session)
	queue.mu.Lock()
	last := len(queue.pending) - 1
	if last >= 0 && event.Type == "timeupdate" && queue.pending[last].Type == "timeupdate" && queue.pending[last].Snapshot.Session == event.Snapshot.Session {
		queue.pending[last] = event
	} else {
		queue.pending = append(queue.pending, event)
	}
	queue.mu.Unlock()
	select {
	case queue.wake <- struct{}{}:
	default:
	}
}

func (queue *mpvEventQueue) current(event MpvEvent) bool {
	return queue.ctx.Err() == nil && queue.session.Load() == event.Snapshot.Session
}

func (queue *mpvEventQueue) run(dispatch func(MpvEvent)) {
	for {
		select {
		case <-queue.ctx.Done():
			return
		case <-queue.wake:
		}
		queue.mu.Lock()
		pending := queue.pending
		queue.pending = nil
		queue.mu.Unlock()
		for _, event := range pending {
			if queue.current(event) {
				dispatch(event)
			}
		}
	}
}
