//go:build darwin

package main

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

var windowButtonsAppKit struct {
	once         sync.Once
	err          error
	ownerClass   objc.Class
	initTracking func(objc.ID, objc.SEL, windowButtonsRect, uint, objc.ID, objc.ID) objc.ID
	point        func(objc.ID, objc.SEL) windowButtonsPoint
	convertPoint func(objc.ID, objc.SEL, windowButtonsPoint, objc.ID) windowButtonsPoint
	bounds       func(objc.ID, objc.SEL) windowButtonsRect
	mainThread   func() int
}

var windowButtonsOwners = struct {
	sync.Mutex
	items map[objc.ID]*windowButtonsHover
}{items: make(map[objc.ID]*windowButtonsHover)}

func windowButtonsSend(id objc.ID, name string, args ...any) objc.ID {
	return id.Send(objc.RegisterName(name), args...)
}

func loadWindowButtonsAppKit() error {
	a := &windowButtonsAppKit
	a.once.Do(func() {
		defer func() {
			if p := recover(); p != nil {
				a.err = fmt.Errorf("初始化原生窗口按钮 hover: %v", p)
			}
		}()
		// MyGo has already loaded AppKit. No framework handles or extra
		// callbacks are allocated for individual windows.
		if objc.GetClass("NSTrackingArea") == 0 || objc.GetClass("NSWindow") == 0 {
			a.err = fmt.Errorf("AppKit 尚未加载")
			return
		}
		msg, err := purego.Dlsym(purego.RTLD_DEFAULT, "objc_msgSend")
		if err != nil {
			a.err = err
			return
		}
		purego.RegisterFunc(&a.initTracking, msg)
		purego.RegisterFunc(&a.point, msg)
		purego.RegisterFunc(&a.convertPoint, msg)
		// CGRect returns need stret on Intel; CGRect arguments to
		// initWithRect: use ordinary objc_msgSend on both architectures,
		// matching MyGo's msgInitTracking registration.
		if runtime.GOARCH == "amd64" {
			msg, err = purego.Dlsym(purego.RTLD_DEFAULT, "objc_msgSend_stret")
			if err != nil {
				a.err = err
				return
			}
		}
		purego.RegisterFunc(&a.bounds, msg)
		purego.RegisterLibFunc(&a.mainThread, purego.RTLD_DEFAULT, "pthread_main_np")
		a.ownerClass, a.err = objc.RegisterClass("HEMusicWindowButtonsHoverOwner", objc.GetClass("NSObject"), nil, nil, nil)
		if a.err != nil {
			return
		}
		// Both selectors share one IMP: one callback for this signature for
		// the lifetime of the process, rather than one callback per window.
		imp := objc.NewIMP(windowButtonsMouseEvent)
		for _, name := range []string{"mouseEntered:", "mouseExited:"} {
			if !a.ownerClass.AddMethod(objc.RegisterName(name), imp, "v@:@") {
				a.err = fmt.Errorf("注册 %s 失败", name)
				return
			}
		}
	})
	return a.err
}

func windowButtonsMouseEvent(owner objc.ID, cmd objc.SEL, event objc.ID) {
	windowButtonsOwners.Lock()
	h := windowButtonsOwners.items[owner]
	windowButtonsOwners.Unlock()
	if h == nil {
		return
	}
	windowButtonsGuard(h, func() {
		area := uintptr(windowButtonsSend(event, "trackingArea"))
		h.entered(area, cmd == objc.RegisterName("mouseEntered:"))
	})
}

// A Go panic must never unwind through AppKit's Objective-C callback stack.
func windowButtonsGuard(h *windowButtonsHover, fn func()) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("原生窗口按钮 hover 失败: %v", p)
			func() {
				defer func() {
					if p := recover(); p != nil {
						log.Printf("清理原生窗口按钮 hover 失败: %v", p)
					}
				}()
				h.dispose()
			}()
		}
	}()
	fn()
}

type windowButtonsDarwin struct {
	window, view, owner objc.ID
	buttons             [3]objc.ID
}

type windowButtonsPoint struct{ X, Y float64 }

func (n *windowButtonsDarwin) containsPointer(rect windowButtonsRect) bool {
	point := windowButtonsAppKit.point(n.window, objc.RegisterName("mouseLocationOutsideOfEventStream"))
	point = windowButtonsAppKit.convertPoint(n.view, objc.RegisterName("convertPoint:fromView:"), point, 0)
	return rect.Width > 0 && rect.Height > 0 && point.X >= rect.X && point.X < rect.X+rect.Width &&
		point.Y >= rect.Y && point.Y < rect.Y+rect.Height
}

func (n *windowButtonsDarwin) newArea(rect windowButtonsRect) (uintptr, error) {
	// entered/exited + activeAlways. No mouse polling or moved events.
	options := uint(0x01 | 0x80)
	if n.containsPointer(rect) {
		options |= 0x100 // NSTrackingAssumeInside, so leaving emits mouseExited.
	}
	area := windowButtonsAppKit.initTracking(
		windowButtonsSend(objc.ID(objc.GetClass("NSTrackingArea")), "alloc"),
		objc.RegisterName("initWithRect:options:owner:userInfo:"), rect, options, n.owner, 0,
	)
	if area == 0 {
		return 0, fmt.Errorf("创建 NSTrackingArea 失败")
	}
	return uintptr(area), nil
}

func (n *windowButtonsDarwin) addArea(area uintptr) error {
	windowButtonsSend(n.view, "addTrackingArea:", area)
	if windowButtonsSend(windowButtonsSend(n.view, "trackingAreas"), "containsObject:", area) == 0 {
		return fmt.Errorf("添加 NSTrackingArea 失败")
	}
	return nil
}

func (n *windowButtonsDarwin) removeArea(area uintptr) {
	windowButtonsSend(n.view, "removeTrackingArea:", area)
	windowButtonsSend(objc.ID(area), "release")
}

func (n *windowButtonsDarwin) showButtons(show bool) {
	var hidden uintptr
	if !show {
		hidden = 1
	}
	for _, button := range n.buttons {
		if button != 0 {
			windowButtonsSend(button, "setHidden:", hidden)
		}
	}
}

func (n *windowButtonsDarwin) release() {
	for _, button := range n.buttons {
		if button != 0 {
			windowButtonsSend(button, "release")
		}
	}
	for _, object := range []objc.ID{n.owner, n.view, n.window} {
		if object != 0 {
			windowButtonsSend(object, "release")
		}
	}
}

// installWindowButtonsHover must be installed after NewWindow on MyGo's main
// thread. Dispose also runs on that thread (including OnClosed). The window
// must use Frameless=false, TitleBarStyle=hidden, HideWindowButtons=false.
func installWindowButtonsHover(win *mygo.Window, enabled bool) (dispose func(), err error) {
	dispose = func() {}
	if !enabled || os.Getenv("MYGO_GENERATE") != "" {
		return dispose, nil
	}
	if win == nil {
		return dispose, fmt.Errorf("原生窗口按钮 hover 缺少窗口")
	}
	if err := loadWindowButtonsAppKit(); err != nil {
		return dispose, err
	}
	if windowButtonsAppKit.mainThread() == 0 {
		return dispose, fmt.Errorf("原生窗口按钮 hover 必须在主线程安装")
	}
	n := &windowButtonsDarwin{}
	h := &windowButtonsHover{native: n}
	// Roll back every successfully retained object if setup fails or panics.
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("安装原生窗口按钮 hover: %v", p)
		}
		if err != nil {
			h.dispose()
		}
	}()
	n.window = windowButtonsSend(objc.ID(win.NativeHandle()), "retain")
	if n.window == 0 {
		return dispose, fmt.Errorf("NSWindow 不可用")
	}
	n.view = windowButtonsSend(windowButtonsSend(n.window, "contentView"), "retain")
	if n.view == 0 {
		return dispose, fmt.Errorf("NSWindow contentView 不可用")
	}
	for i := range n.buttons {
		n.buttons[i] = windowButtonsSend(windowButtonsSend(n.window, "standardWindowButton:", uintptr(i)), "retain")
		if n.buttons[i] == 0 {
			return dispose, fmt.Errorf("原生窗口按钮 %d 不可用", i)
		}
	}
	n.owner = windowButtonsSend(windowButtonsSend(objc.ID(windowButtonsAppKit.ownerClass), "alloc"), "init")
	if n.owner == 0 {
		return dispose, fmt.Errorf("创建窗口按钮 tracking owner 失败")
	}
	windowButtonsOwners.Lock()
	windowButtonsOwners.items[n.owner] = h
	windowButtonsOwners.Unlock()
	h.unroute = func() {
		windowButtonsOwners.Lock()
		delete(windowButtonsOwners.items, n.owner)
		windowButtonsOwners.Unlock()
	}
	refresh := func() error {
		if h.disposed {
			return nil
		}
		// AppKit owns the full-screen title bar and its auto-hidden buttons.
		if uint64(windowButtonsSend(n.window, "styleMask"))&(1<<14) != 0 {
			h.suspend()
			return nil
		}
		bounds := windowButtonsAppKit.bounds(n.view, objc.RegisterName("bounds"))
		return h.refresh(bounds, windowButtonsSend(n.view, "isFlipped") != 0)
	}
	if err = refresh(); err != nil {
		return dispose, err
	}
	update := func() {
		windowButtonsGuard(h, func() {
			if err := refresh(); err != nil {
				log.Printf("更新原生窗口按钮 hover 失败: %v", err)
			}
		})
	}
	cleanup := func() { windowButtonsGuard(h, h.dispose) }
	h.off = append(h.off, win.OnResize(update))
	h.off = append(h.off, win.OnEnterFullScreen(update))
	h.off = append(h.off, win.OnLeaveFullScreen(update))
	h.off = append(h.off, win.OnClosed(cleanup))
	return func() { mygo.RunOnMain(cleanup) }, nil
}
