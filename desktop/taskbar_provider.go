package main

import (
	"context"
	"errors"
	"log"
	"runtime"

	"github.com/egoist/mygo"
)

var desktopTaskbarCommand = mygo.NewEvent[TaskbarCommand]("desktop:taskbar-command")
var desktopTaskbarFailure = mygo.NewEvent[TaskbarFailure]("desktop:taskbar-failure")
var desktopTaskbar = &Taskbar{controller: taskbarController{open: openTaskbar}}

// Taskbar shares the Ready main-page owner; construction never touches native APIs.
type Taskbar struct{ controller taskbarController }

func init() {
	desktopTaskbar.controller.emit = func(command TaskbarCommand) {
		l := desktopLifecycle
		if l.main == nil || l.main.IsDestroyed() || l.state.owner == nil || l.state.owner.Err() != nil {
			desktopTaskbar.revoke()
			return
		}
		if err := desktopTaskbarCommand.EmitPage(l.main.Page(), command); err != nil {
			desktopTaskbar.revoke()
		}
	}
	desktopTaskbar.controller.failure = func(failure TaskbarFailure) {
		l := desktopLifecycle
		if l.main == nil || l.main.IsDestroyed() || l.state.owner == nil || l.state.owner.Err() != nil {
			return
		}
		if err := desktopTaskbarFailure.EmitPage(l.main.Page(), failure); err != nil {
			log.Print("任务栏失败通知发送失败: ", err)
		}
	}
	mygo.Bind(desktopTaskbar)
}
func (t *Taskbar) Begin(ctx context.Context) (uint64, error) {
	var epoch uint64
	err := desktopLifecycle.call(ctx, true, func() error {
		if runtime.GOOS != "windows" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
			return errors.New("taskbar requires 64-bit Windows")
		}
		var err error
		epoch, err = t.controller.begin(desktopLifecycle.main.NativeHandle())
		return err
	})
	return epoch, err
}

// Sync acknowledges acceptance. Native application can complete later when COM
// reenters; only completion opens the command gate. An accepted native failure
// emits desktop:taskbar-failure with the matching epoch and sequence.
func (t *Taskbar) Sync(ctx context.Context, state TaskbarState) error {
	return desktopLifecycle.call(ctx, true, func() error { return taskbarAcceptance(t.controller.sync(state)) })
}
func taskbarAcceptance(err error) error {
	// Do not hide a real failure joined with a queued cleanup result.
	if err == errTaskbarQueued {
		return nil
	}
	return err
}
func (t *Taskbar) Teardown(ctx context.Context, epoch uint64) error {
	return desktopLifecycle.call(ctx, true, func() error {
		if epoch == 0 || epoch != t.controller.state.Epoch {
			return errors.New("stale taskbar teardown")
		}
		return t.controller.revoke()
	})
}

// Parent lifecycle calls revoke on Ready replacement, navigation, owner revoke and before quit.
func (t *Taskbar) revoke() {
	if err := t.controller.revoke(); err != nil && err != errTaskbarQueued {
		log.Print("任务栏控件清理失败: ", err)
	}
}

// Parent calls shutdown on OnClosed and final quit, always on the main thread.
func (t *Taskbar) shutdown() {
	if err := t.controller.shutdown(); err != nil && err != errTaskbarQueued {
		log.Print("任务栏原生资源释放失败: ", err)
	}
}
