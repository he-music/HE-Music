//go:build linux && (amd64 || arm64)

package gl

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// GLX's functions UnsyncGLXSwaps calls, through libepoxy's pointers, as GDK
// calls them; nil where libepoxy has no GLX.
var glx struct {
	once           sync.Once
	currentDisplay *uintptr // glXGetCurrentDisplay
	currentContext *uintptr // glXGetCurrentContext
	currentDrawn   *uintptr // glXGetCurrentDrawable
	queryContext   *uintptr // glXQueryContext
	intervalEXT    *uintptr // glXSwapIntervalEXT
	intervalMESA   *uintptr // glXSwapIntervalMESA
	hasExtension   func(dpy uintptr, screen int32, ext string) bool
}

// glxScreen is GLX_SCREEN, which glXQueryContext tells.
const glxScreen = 0x800C

// UnsyncGLXSwaps sets the swap interval of the GLX drawable current to 0,
// so that its swaps wait for no vertical blank, for frames uncapped
// (MYGO_UNCAPPED): the backend calls it as GDK paints a window it
// composites with OpenGL on X11, with the window's paint context current.
// GDK sets 1 there on a display without a compositor, which holds frames
// to the display's refreshes, and 0 under a compositor, which paces the
// window itself (gdk/x11/gdkglcontext-x11.c); GDK's EGL, on Wayland, swaps
// with 0 already. It sets the interval with GLX_EXT_swap_control, else
// GLX_MESA_swap_control (GLX_SGI_swap_control takes no 0), and does
// nothing without either, or without a context current. GDK sets its own
// interval again only when a compositor starts or stops, so a call each
// paint keeps 0, which costs nothing once set.
func UnsyncGLXSwaps() {
	if load() != nil {
		return
	}
	g := &glx
	g.once.Do(func() {
		lib, err := purego.Dlopen("libepoxy.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		ptr := func(name string) *uintptr {
			sym, err := purego.Dlsym(lib, "epoxy_"+name)
			if err != nil || sym == 0 {
				return nil
			}
			return *(**uintptr)(unsafe.Pointer(&sym))
		}
		if sym, err := purego.Dlsym(lib, "epoxy_has_glx_extension"); err == nil && sym != 0 {
			purego.RegisterFunc(&g.hasExtension, sym)
		}
		g.currentDisplay, g.currentContext, g.currentDrawn = ptr("glXGetCurrentDisplay"), ptr("glXGetCurrentContext"), ptr("glXGetCurrentDrawable")
		g.queryContext, g.intervalEXT, g.intervalMESA = ptr("glXQueryContext"), ptr("glXSwapIntervalEXT"), ptr("glXSwapIntervalMESA")
	})
	if g.hasExtension == nil || g.currentDisplay == nil || g.currentContext == nil || g.currentDrawn == nil || g.queryContext == nil {
		return
	}
	dpy, _, _ := purego.SyscallN(*g.currentDisplay)
	ctx, _, _ := purego.SyscallN(*g.currentContext)
	drawable, _, _ := purego.SyscallN(*g.currentDrawn)
	if dpy == 0 || ctx == 0 || drawable == 0 {
		return
	}
	var screen int32
	if r, _, _ := purego.SyscallN(*g.queryContext, dpy, ctx, glxScreen, uintptr(unsafe.Pointer(&screen))); r != 0 {
		return // not Success
	}
	switch {
	case g.intervalEXT != nil && g.hasExtension(dpy, screen, "GLX_EXT_swap_control"):
		purego.SyscallN(*g.intervalEXT, dpy, drawable, 0)
	case g.intervalMESA != nil && g.hasExtension(dpy, screen, "GLX_MESA_swap_control"):
		purego.SyscallN(*g.intervalMESA, 0)
	}
}
