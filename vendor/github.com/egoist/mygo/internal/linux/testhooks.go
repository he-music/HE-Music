//go:build linux && (amd64 || arm64)

package linux

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// The functions in this file drive native UI the way a user would, for the
// GUI tests in internal/e2e. They must run on the main thread.

// TestActivateMenuItem activates an item of a window's menu bar, found by
// the labels along its path.
func TestActivateMenuItem(handle uintptr, path ...string) error {
	item, err := menuItemAt(handle, path)
	if err == nil {
		gtkMenuItemActivate(item)
	}
	return err
}

// menuItemAt finds an item of a window's menu bar by the labels along its
// path.
func menuItemAt(handle uintptr, path []string) (ptr, error) {
	w := windowByHandle(handle)
	if w == nil || w.menubar == 0 {
		return 0, fmt.Errorf("mygo: window has no menu bar")
	}
	shell := w.menubar
	for i, label := range path {
		item := findMenuItem(shell, label)
		if item == 0 {
			return 0, fmt.Errorf("mygo: no menu item %q", label)
		}
		if i == len(path)-1 {
			return item, nil
		}
		shell = gtkMenuItemGetSubmenu(item)
		if shell == 0 {
			return 0, fmt.Errorf("mygo: menu %q has no submenu", label)
		}
	}
	return 0, fmt.Errorf("mygo: no menu item")
}

func findMenuItem(shell ptr, label string) ptr {
	list := gtkContainerGetChildren(shell)
	defer gListFree(list)
	for node := list; node != 0; node = field[ptr](node, 8) {
		item := field[ptr](node, 0)
		if menuItemLabel(item) == label {
			return item
		}
	}
	return 0
}

// menuItemLabel returns the label of a menu item, which one with an icon
// holds in a box with the image.
func menuItemLabel(item ptr) string {
	loadMenuTests()
	for _, list := range itemsByID {
		for _, n := range list {
			if n.item == item && n.label != 0 {
				return goStr(gtkLabelGetLabel(n.label))
			}
		}
	}
	return goStr(gtkMenuItemGetLabel(item))
}

var (
	menuTestOnce              sync.Once
	gtkLabelGetLabel          func(label ptr) ptr
	gtkCheckMenuItemGetActive func(item ptr) bool
)

func loadMenuTests() {
	menuTestOnce.Do(func() {
		mustBind(libGTK, &gtkLabelGetLabel, "gtk_label_get_label")
		mustBind(libGTK, &gtkCheckMenuItemGetActive, "gtk_check_menu_item_get_active")
	})
}

// TestMenuItemIcon reports the size, in points, of the icon an item of a
// window's menu bar shows, 0 by 0 for none, and whether the item is
// checked.
func TestMenuItemIcon(handle uintptr, path ...string) (width, height int, checked bool, err error) {
	loadMenuTests()
	item, err := menuItemAt(handle, path)
	if err != nil {
		return 0, 0, false, err
	}
	for _, list := range itemsByID {
		for _, n := range list {
			if n.item != item {
				continue
			}
			if n.check {
				checked = gtkCheckMenuItemGetActive(item)
			}
			if n.image != 0 && gtkWidgetGetVisible(n.image) {
				var minimum, w, h int32
				gtkWidgetGetPreferredWidth(n.image, &minimum, &w)
				gtkWidgetGetPreferredHeight(n.image, &minimum, &h)
				width, height = int(w), int(h)
			}
			return width, height, checked, nil
		}
	}
	return 0, 0, false, fmt.Errorf("mygo: the item is not MyGo's")
}

func windowByHandle(handle uintptr) *window {
	for _, w := range theBackend.windows {
		if w.win == handle {
			return w
		}
	}
	return nil
}

// TestMenuBarState reports whether a window shows its menu bar, and whether
// the bar's first menu is open.
func TestMenuBarState(handle uintptr) (shown, open bool) {
	w := windowByHandle(handle)
	if w == nil || w.menubar == 0 {
		return false, false
	}
	if item := firstMenu(w.menubar); item != 0 {
		if sub := gtkMenuItemGetSubmenu(item); sub != 0 {
			open = gtkWidgetGetVisible(sub)
		}
	}
	return gtkWidgetGetVisible(w.menubar), open
}

// TestCloseMenuBar closes the menus of a window's menu bar, as Escape does.
func TestCloseMenuBar(handle uintptr) {
	if w := windowByHandle(handle); w != nil && w.menubar != 0 {
		gtkMenuShellDeactivate(w.menubar)
	}
}

// TestActivateAccelerator presses a window's shortcut, as its keys do, and
// reports whether a menu item took it.
func TestActivateAccelerator(handle uintptr, acc string) bool {
	var activate func(object ptr, key, mods uint32) bool
	key, mods, ok := gtkAccelerator(acc)
	return ok && bind(libGTK, &activate, "gtk_accel_groups_activate") && activate(handle, key, mods)
}

// TestDismissPopups closes the context menus being shown, as if the user
// pressed Escape, and reports how many there were.
func TestDismissPopups() int {
	for _, m := range theBackend.popups {
		gtkMenuShellDeactivate(m)
	}
	return len(theBackend.popups)
}

// TestSetDroppedFiles makes paths the files of the next drop on a window's
// page, as if they had been dragged there.
func TestSetDroppedFiles(handle uintptr, paths []string) {
	for _, w := range theBackend.windows {
		if w.win == handle {
			w.dropped = paths
		}
	}
}

// TestDefaultURLHandler returns the id of the application GLib opens URLs
// of scheme with, as xdg-open and GTK apps do.
func TestDefaultURLHandler(scheme string) string {
	info := gAppInfoGetDefaultForURIScheme(cs(scheme))
	if info == 0 {
		return ""
	}
	defer gObjectUnref(info)
	return goStr(gAppInfoGetID(info))
}

// xtest holds the functions of the XTEST extension, which fake input like
// a keyboard or mouse would, and XSync, which waits for the X server to
// make the events.
var xtest struct {
	key    func(dpy ptr, keycode uint32, press bool, delay uint64) int32
	button func(dpy ptr, button uint32, press bool, delay uint64) int32
	motion func(dpy ptr, screen int32, x, y int32, delay uint64) int32
	sync   func(dpy ptr, discard bool) int32
}

// gdkEventsPending reports whether GDK has events it has yet to handle.
var gdkEventsPending func() bool

// loadXTest binds the XTEST extension and returns the X display, or 0
// without an X server.
func loadXTest() ptr {
	if !loadX11() {
		return 0
	}
	if xtest.key == nil {
		lib, err := open("libXtst.so.6")
		x, xerr := open("libX11.so.6")
		if err != nil || xerr != nil || !bind(lib, &xtest.button, "XTestFakeButtonEvent") ||
			!bind(lib, &xtest.motion, "XTestFakeMotionEvent") || !bind(x, &xtest.sync, "XSync") ||
			!bind(libGDK, &gdkEventsPending, "gdk_events_pending") || !bind(lib, &xtest.key, "XTestFakeKeyEvent") {
			return 0
		}
	}
	return x11.xdisplay(gdkDisplayGetDefault())
}

// sent waits for the X server to have made the events of the input faked
// on dpy. The server makes them as it handles the requests, before it
// replies to XSync's, and Xlib reads them into the app's queue, ahead of
// the reply: GDK handles them next, on the main thread, after the hook
// returns. TestInputPending tells when it did.
func sent(dpy ptr) { xtest.sync(dpy, false) }

// TestInputPending reports whether the app has events it has yet to
// handle: once it reports false after a hook faked input through XTEST,
// the app handled that input, as a window's content does on the main
// thread when GDK hands it an event. GDK leaves out a last motion, which
// it holds until the window's next frame to merge it with the next ones.
func TestInputPending() bool { return gdkEventsPending != nil && gdkEventsPending() }

// TestPressKeys presses keys, X keysym names such as "Control_L", together
// and releases them, through the XTEST extension like a keyboard would. It
// reports false without an X server.
func TestPressKeys(names ...string) bool {
	dpy := loadXTest()
	if dpy == 0 {
		return false
	}
	var codes []uint32
	for _, n := range names {
		codes = append(codes, uint32(x11.keysymToKeycode(dpy, x11.stringToKeysym(cs(n)))))
	}
	for _, c := range codes {
		xtest.key(dpy, c, true, 0)
	}
	for i := len(codes) - 1; i >= 0; i-- {
		xtest.key(dpy, codes[i], false, 0)
	}
	sent(dpy)
	return true
}

// TestMovePointer moves the pointer to a point of the screen through the
// XTEST extension like a mouse would. It reports false without an X server.
func TestMovePointer(x, y int) bool {
	dpy := loadXTest()
	if dpy == 0 {
		return false
	}
	xtest.motion(dpy, -1, int32(x), int32(y), 0) // -1: the pointer's screen
	sent(dpy)
	return true
}

// TestPressButton presses or releases the first mouse button the same way.
func TestPressButton(press bool) bool { return pressButton(1, press) }

// pressButton presses or releases a mouse button, 1 the primary, 3 the
// secondary.
func pressButton(button uint32, press bool) bool {
	dpy := loadXTest()
	if dpy == 0 {
		return false
	}
	xtest.button(dpy, button, press, 0)
	sent(dpy)
	return true
}

// TestPopups returns the labels of the items of the context menus being
// shown, "-" for separators.
func TestPopups() [][]string {
	var menus [][]string
	for _, m := range theBackend.popups {
		labels := []string{}
		list := gtkContainerGetChildren(m)
		for node := list; node != 0; node = field[ptr](node, 8) {
			label := goStr(gtkMenuItemGetLabel(field[ptr](node, 0)))
			if label == "" {
				label = "-"
			}
			labels = append(labels, label)
		}
		gListFree(list)
		menus = append(menus, labels)
	}
	return menus
}

// TestChoosePopupItem chooses the item labeled label of a context menu
// being shown, and closes the menu, and reports whether it has one.
func TestChoosePopupItem(label string) bool {
	for _, m := range theBackend.popups {
		if item := findMenuItem(m, label); item != 0 {
			gtkMenuItemActivate(item)
			gtkMenuShellDeactivate(m)
			return true
		}
	}
	return false
}

// TestResizeCursor returns the name of the resize cursor a frameless
// window shows over an edge of its page, or "".
func TestResizeCursor(handle uintptr) string {
	for _, w := range theBackend.windows {
		if w.win == handle && w.cursor.on {
			return resizeEdges[w.cursor.edge].cursor
		}
	}
	return ""
}

// TestUsePortalShortcuts makes global shortcuts bind through the XDG desktop
// portal, as on Wayland, and reports whether the desktop offers it.
func TestUsePortalShortcuts(on bool) bool {
	portalShortcutsOnly = on
	return !on || portalVersion(shortcutsPortal) != 0
}

// Walking a header bar's own children, its title buttons among them.
var (
	walkOnce                sync.Once
	walkCallback            ptr
	walked                  []ptr
	gtkContainerForall      func(c, cb, data ptr)
	gtkContainerGetType     func() uintptr
	gtkStyleContextHasClass func(c ptr, name *byte) bool
	gtkButtonClicked        func(b ptr)
)

// titleButtons returns the title buttons shown over the page of a window
// with a hidden title bar, in order across its bars, with their names:
// "minimize", "maximize" or "close".
func titleButtons(w *window) (names []string, buttons []ptr) {
	walkOnce.Do(func() {
		mustBind(libGTK, &gtkContainerForall, "gtk_container_forall")
		mustBind(libGTK, &gtkContainerGetType, "gtk_container_get_type")
		mustBind(libGTK, &gtkStyleContextHasClass, "gtk_style_context_has_class")
		mustBind(libGTK, &gtkButtonClicked, "gtk_button_clicked")
		walkCallback = purego.NewCallback(func(widget, data ptr) {
			walked = append(walked, widget)
			if gTypeCheckInstanceIsA(widget, gtkContainerGetType()) {
				gtkContainerForall(widget, walkCallback, 0)
			}
		})
	})
	if w == nil || w.controls == nil {
		return nil, nil
	}
	for _, bar := range w.controls.bars {
		if bar == 0 {
			continue
		}
		walked = nil
		gtkContainerForall(bar, walkCallback, 0)
		for _, widget := range walked {
			style := gtkWidgetGetStyleContext(widget)
			if !gtkWidgetGetVisible(widget) || !gtkStyleContextHasClass(style, cs("titlebutton")) {
				continue
			}
			for _, name := range []string{"minimize", "maximize", "close"} {
				if gtkStyleContextHasClass(style, cs(name)) {
					names, buttons = append(names, name), append(buttons, widget)
				}
			}
		}
	}
	return names, buttons
}

// TestTitleButtons returns the names of the title buttons over the page of
// a window with a hidden title bar.
func TestTitleButtons(handle uintptr) []string {
	names, _ := titleButtons(windowByHandle(handle))
	return names
}

// TestPressTitleButton clicks one of them.
func TestPressTitleButton(handle uintptr, name string) bool {
	names, buttons := titleButtons(windowByHandle(handle))
	for i, n := range names {
		if n == name {
			gtkButtonClicked(buttons[i])
			return true
		}
	}
	return false
}

// TestClickSurface clicks (x, y), in DIPs, in a window showing native UI,
// through the XTEST extension like a mouse would. It reports false for a
// window showing a web page, and without an X server.
func TestClickSurface(handle uintptr, x, y float64) bool {
	return clickSurface(handle, x, y, 1)
}

func clickSurface(handle uintptr, x, y float64, button uint32) bool {
	w := windowByHandle(handle)
	if w == nil || w.surface == nil {
		return false
	}
	var origin func(window ptr, x, y *int32) int32
	if !bind(libGDK, &origin, "gdk_window_get_origin") {
		return false
	}
	var ox, oy int32
	origin(w.surface.eventWindow(), &ox, &oy)
	scale := float64(gtkWidgetGetScaleFactor(w.surface.area))
	if !TestMovePointer(int((float64(ox)+x)*scale), int((float64(oy)+y)*scale)) {
		return false
	}
	return pressButton(button, true) && pressButton(button, false)
}

// TestClickPage clicks (x, y), in DIPs, in the page of a window's web
// view, through XTEST, as a user clicks it.
func TestClickPage(handle uintptr, x, y float64) bool {
	w := windowByHandle(handle)
	if w == nil || w.surface != nil || w.web == 0 {
		return false
	}
	loadFlyouts() // contentOrigin's
	loadSurface() // gtk_widget_get_scale_factor
	ox, oy := w.contentOrigin()
	scale := float64(max(gtkWidgetGetScaleFactor(w.web), 1))
	if !TestMovePointer(int((float64(ox)+x)*scale), int((float64(oy)+y)*scale)) {
		return false
	}
	return pressButton(1, true) && pressButton(1, false)
}

// TestSideButton clicks a mouse's back or forward button (buttons 8 and
// 9) in a window showing native UI, through XTEST.
func TestSideButton(handle uintptr, back bool) bool {
	button := uint32(9)
	if back {
		button = 8
	}
	return clickSurface(handle, 20, 20, button)
}

// TestDragSurface presses the primary button at the first of points, in
// DIPs, in a window showing native UI, moves the pointer through the
// others, and releases it at the last, through XTEST.
func TestDragSurface(handle uintptr, points [][2]float64) bool {
	w := windowByHandle(handle)
	if w == nil || w.surface == nil || len(points) < 2 {
		return false
	}
	var origin func(window ptr, x, y *int32) int32
	if !bind(libGDK, &origin, "gdk_window_get_origin") {
		return false
	}
	var ox, oy int32
	origin(w.surface.eventWindow(), &ox, &oy)
	scale := float64(gtkWidgetGetScaleFactor(w.surface.area))
	move := func(p [2]float64) bool {
		return TestMovePointer(int((float64(ox)+p[0])*scale), int((float64(oy)+p[1])*scale))
	}
	if !move(points[0]) || !pressButton(1, true) {
		return false
	}
	for _, p := range points[1:] {
		move(p)
	}
	return pressButton(1, false)
}

// TestRightClickSurface clicks (x, y) with the secondary button, as
// TestClickSurface does with the primary.
func TestRightClickSurface(handle uintptr, x, y float64) bool {
	return clickSurface(handle, x, y, 3)
}

// TestHasRecentItem reports whether the shared recent files list holds the
// file at path, as App.AddRecentDocument put it there.
func TestHasRecentItem(path string) bool {
	return gtkRecentManagerHasItem(gtkRecentManagerGetDefault(), cs(fileURI(path)))
}

// TestWindowTitle returns the title GTK gives a window.
func TestWindowTitle(handle uintptr) string { return goStr(gtkWindowGetTitle(handle)) }

// TestPinchSurface pinches a touchpad at (x, y), in DIPs, in a window
// showing native UI, from 1 to scale: the begin, update and end events of
// GDK's pinch, which only Wayland makes, go through GTK as its own do.
func TestPinchSurface(handle uintptr, x, y, scale float64) bool {
	w := windowByHandle(handle)
	if w == nil || w.surface == nil {
		return false
	}
	var eventNew func(typ int32) ptr
	var doEvent func(event ptr)
	var setDevice func(event, device ptr)
	var display func() ptr
	var seat func(display ptr) ptr
	var pointer func(seat ptr) ptr
	if !bind(libGDK, &eventNew, "gdk_event_new") || !bind(libGTK, &doEvent, "gtk_main_do_event") ||
		!bind(libGDK, &setDevice, "gdk_event_set_device") || !bind(libGDK, &display, "gdk_display_get_default") ||
		!bind(libGDK, &seat, "gdk_display_get_default_seat") || !bind(libGDK, &pointer, "gdk_seat_get_pointer") {
		return false
	}
	device := pointer(seat(display()))
	win := w.surface.eventWindow()
	if win == 0 {
		return false
	}
	// GdkEventTouchpadPinch: window 8, send_event 16, phase 17, n_fingers
	// 18, x 24, y 32, scale 64.
	for phase, at := range []float64{1, scale, scale} {
		ev := eventNew(42) // GDK_TOUCHPAD_PINCH
		base := *(*unsafe.Pointer)(unsafe.Pointer(&ev))
		*(*ptr)(unsafe.Add(base, 8)) = gObjectRef(win)
		*(*int8)(unsafe.Add(base, 16)) = 1
		*(*int8)(unsafe.Add(base, 17)) = int8(phase) // begin, update, end
		*(*int8)(unsafe.Add(base, 18)) = 2
		*(*float64)(unsafe.Add(base, 24)) = x
		*(*float64)(unsafe.Add(base, 32)) = y
		*(*float64)(unsafe.Add(base, 64)) = at
		setDevice(ev, device)
		doEvent(ev)
		gdkEventFree(ev)
	}
	return true
}

// TestTrayActivates tells whether the AppIndicator library can report
// activation at all; call it after making a tray.
func TestTrayActivates() bool { return trayActivates() }

// TestActivateTray activates the tray icon made last, as a panel does when
// its icon is double-clicked. It reports false when the icon answers no
// activation: no click has anywhere to go.
func TestActivateTray() bool {
	var last *tray
	for _, t := range theBackend.trays {
		if last == nil || t.id > last.id {
			last = t
		}
	}
	if last == nil || last.activate == 0 {
		return false
	}
	var lookup func(name *byte, typ uintptr) uint32
	var typeFromName func(name *byte) uintptr
	var emit func(instance ptr, signal, detail uint32, x, y int32)
	if !bind(libGObject, &lookup, "g_signal_lookup") ||
		!bind(libGObject, &typeFromName, "g_type_from_name") ||
		!bind(libGObject, &emit, "g_signal_emit") {
		return false
	}
	signal := lookup(cs("activate"), typeFromName(cs("AppIndicator")))
	if signal == 0 {
		return false
	}
	emit(last.ind, signal, 0, 0, 0)
	return true
}

// Decorations are what TestDecorations reports.
type Decorations struct {
	// CSD tells that GTK decorates the window itself (useCSD).
	CSD bool
	// Room is the room its decorations take around the window's content,
	// left, top, right and bottom: the shadow and the border, where GTK
	// resizes the window. Content is the size of the page or the native
	// UI, below a menu bar.
	Room    [4]int
	Content [2]int
	// OnX11 tells the display.
	OnX11 bool
}

// TestDecorations reports how GTK decorates a window.
func TestDecorations(handle uintptr) Decorations {
	d := Decorations{OnX11: theBackend.onX11}
	w := windowByHandle(handle)
	if w == nil {
		return d
	}
	var win, box, content gdkRectangle
	gtkWidgetGetAllocation(w.win, &win)
	gtkWidgetGetAllocation(w.box, &box)
	gtkWidgetGetAllocation(w.contentWidget(), &content)
	d.CSD = w.csd
	d.Room = [4]int{int(box.X), int(box.Y), int(win.Width - box.X - box.Width), int(win.Height - box.Y - box.Height)}
	d.Content = [2]int{int(content.Width), int(content.Height)}
	return d
}
