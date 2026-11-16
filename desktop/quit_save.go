package main

import (
	"context"
	"log"
	"time"
)

// EvalContext awaits the page's promise while MyGo pumps native events. Keeping
// this inside the original quit sequence preserves the SDK's relaunch intent;
// canceling and later calling Quit would lose it. Never wait on a channel here.
type quitSaveGuard struct{ running bool }

func (g *quitSaveGuard) prepare(save func() bool) bool {
	if g.running {
		return false
	}
	g.running = true
	defer func() { g.running = false }()
	return save()
}

func (l *DesktopLifecycle) prepareQuitWrites() bool {
	if !l.saveOnQuit || l.main == nil || l.main.IsDestroyed() || l.state.owner == nil || l.state.quitting {
		return true
	}
	return l.quitSave.prepare(func() bool {
		window, owner := l.main, l.state.owner
		ctx, cancel := context.WithTimeout(owner, 30*time.Second)
		defer cancel()
		value, err := window.Page().EvalContext(ctx, "globalThis.__heMusicPrepareQuit?.() ?? false")
		if err != nil || value != true || l.main != window || l.state.owner != owner {
			log.Print("退出前保存应用数据失败，已保留当前窗口")
			return false
		}
		return true
	})
}
