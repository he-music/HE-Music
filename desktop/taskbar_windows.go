//go:build windows && (amd64 || arm64)

package main

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	taskbarOle               = syscall.NewLazyDLL("ole32.dll")
	taskbarUser              = syscall.NewLazyDLL("user32.dll")
	taskbarComctl            = syscall.NewLazyDLL("comctl32.dll")
	taskbarCoInit            = taskbarOle.NewProc("CoInitializeEx")
	taskbarCoUninit          = taskbarOle.NewProc("CoUninitialize")
	taskbarCoCreate          = taskbarOle.NewProc("CoCreateInstance")
	taskbarSetSubclass       = taskbarComctl.NewProc("SetWindowSubclass")
	taskbarRemoveSubclass    = taskbarComctl.NewProc("RemoveWindowSubclass")
	taskbarDefSubclass       = taskbarComctl.NewProc("DefSubclassProc")
	taskbarRegisterMessage   = taskbarUser.NewProc("RegisterWindowMessageW")
	taskbarPostMessage       = taskbarUser.NewProc("PostMessageW")
	taskbarGetProp           = taskbarUser.NewProc("GetPropW")
	taskbarSetProp           = taskbarUser.NewProc("SetPropW")
	taskbarCreateIcon        = taskbarUser.NewProc("CreateIcon")
	taskbarDestroyIcon       = taskbarUser.NewProc("DestroyIcon")
	taskbarIsWindow          = taskbarUser.NewProc("IsWindow")
	taskbarSubclassCallback  uintptr
	taskbarHooks             = map[uintptr]*windowsTaskbar{}
	taskbarWindows           = map[uintptr]*taskbarWindowRecord{}
	taskbarHookSerial        uintptr
	taskbarButtonSerial      uint32 = 0x5000
	taskbarWindowProperty, _        = syscall.UTF16PtrFromString("HEMusic.TaskbarWindow")
)

type taskbarGUID struct {
	Data1        uint32
	Data2, Data3 uint16
	Data4        [8]byte
}

var (
	taskbarCLSID = taskbarGUID{0x56fdf344, 0xfd6d, 0x11d0, [8]byte{0x95, 0x8a, 0, 0x60, 0x97, 0xc9, 0xa0, 0x90}}
	taskbarIID   = taskbarGUID{0xea1afb91, 0x9e28, 0x4b86, [8]byte{0x90, 0xe9, 0x9e, 0x9f, 0x8a, 0x5e, 0xef, 0xaf}}
)

type taskbarButton struct {
	Mask   uint32
	ID     uint32
	Bitmap uint32
	Icon   uintptr
	Tip    [260]uint16
	Flags  uint32
}
type taskbarWindowRecord struct {
	facts    taskbarNativeWindow
	token    uintptr
	observer *windowsTaskbar
	hooks    taskbarHookHandoff
}
type windowsTaskbar struct {
	taskbarNativeExecutor
	hwnd, id, message, resumeMessage uintptr
	object                           unsafe.Pointer
	icons                            [4]uintptr
	buttons                          [3]taskbarButton
	click                            func(TaskbarAction)
	rebuild                          func()
	comInitialized, hooked           bool
	record                           *taskbarWindowRecord
}

func taskbarHRESULT(op string, v uintptr) error {
	if int32(uint32(v)) < 0 {
		return fmt.Errorf("%s HRESULT 0x%08x", op, uint32(v))
	}
	return nil
}

func (b *windowsTaskbar) invokeCOM(index int, args ...uintptr) error {
	if b.object == nil {
		return errors.New("taskbar COM object unavailable")
	}
	table := *(*unsafe.Pointer)(b.object)
	method := *(*uintptr)(unsafe.Add(table, uintptr(index)*unsafe.Sizeof(uintptr(0))))
	hr, _, _ := syscall.SyscallN(method, append([]uintptr{uintptr(b.object)}, args...)...)
	return taskbarHRESULT("ITaskbarList3", hr)
}

func (b *windowsTaskbar) invokeNative(method int, s TaskbarState, hidden bool) error {
	if b.object == nil && hidden {
		return nil
	}
	if method == 10 {
		state := uintptr(0)
		if !hidden && s.DurationMs > 0 {
			state = 2
			if !s.Playing {
				state = 8
			}
		}
		return b.invokeCOM(10, b.hwnd, state)
	}
	if method == 9 {
		return b.invokeCOM(9, b.hwnd, uintptr(uint64(s.PositionMs)), uintptr(uint64(s.DurationMs)))
	}
	// The call-local array is immutable throughout COM, including message pumping.
	buttons := b.buttons
	labels := [3]string{s.Labels.Previous, s.Labels.Play, s.Labels.Next}
	middle := 1
	if s.Playing {
		middle = 2
		labels[1] = s.Labels.Pause
	}
	icons := [3]uintptr{b.icons[0], b.icons[middle], b.icons[3]}
	for i := range buttons {
		if hidden {
			buttons[i].Mask = 8
			buttons[i].Flags = 9
		} else {
			buttons[i].Mask = 0xe
			buttons[i].Icon = icons[i]
			buttons[i].Flags = 0
			copy(buttons[i].Tip[:], utf16.Encode([]rune(labels[i])))
		}
	}
	// invokeCOM forwards uintptr arguments through Go before SyscallN; pin the
	// backing array so a reentrant callback cannot relocate it with a growing stack.
	var pinned runtime.Pinner
	pinned.Pin(&buttons[0])
	defer pinned.Unpin()
	err := b.invokeCOM(method, b.hwnd, 3, uintptr(unsafe.Pointer(&buttons[0])))
	runtime.KeepAlive(buttons)
	runtime.KeepAlive(b)
	return err
}

func openTaskbar(hwnd uintptr, click func(TaskbarAction), rebuild func()) (taskbarBackend, error) {
	valid, _, _ := taskbarIsWindow.Call(hwnd)
	if valid == 0 {
		return nil, errors.New("invalid taskbar HWND")
	}
	if taskbarHookSerial == ^uintptr(0) {
		return nil, errors.New("taskbar native identity exhausted")
	}
	taskbarHookSerial++
	b := &windowsTaskbar{hwnd: hwnd, id: taskbarHookSerial, click: click, rebuild: rebuild}
	token, _, _ := taskbarGetProp.Call(hwnd, uintptr(unsafe.Pointer(taskbarWindowProperty)))
	record := taskbarWindows[hwnd]
	if record == nil || token == 0 || record.token != token {
		if taskbarButtonSerial > 0xfffc {
			return nil, errors.New("taskbar button identity exhausted")
		}
		record = &taskbarWindowRecord{token: b.id}
		for i := range record.facts.buttonIDs {
			taskbarButtonSerial++
			record.facts.buttonIDs[i] = taskbarButtonSerial
		}
		ok, _, _ := taskbarSetProp.Call(hwnd, uintptr(unsafe.Pointer(taskbarWindowProperty)), record.token)
		if ok == 0 {
			return nil, errors.New("SetProp taskbar window failed")
		}
		taskbarWindows[hwnd] = record
	}
	// Remove failed replacements before installing another; keep the record's
	// observer alive through native construction and any Explorer recreation.
	if err := record.hooks.retryKeeping(record.observer); err != nil {
		return nil, err
	}
	previous := record.observer
	// Reserve the HWND before CoInitialize/CoCreate/HrInit can pump messages.
	if previous != nil && !previous.closed {
		return nil, errors.New("taskbar HWND native owner still in use")
	}
	b.record = record
	b.taskbarNativeWindow = &record.facts
	record.observer = b
	for i := range b.buttons {
		b.buttons[i].ID = record.facts.buttonIDs[i]
	}
	b.taskbarNativeExecutor.invoke = b.invokeNative
	b.taskbarNativeExecutor.release = b.releaseNative
	b.taskbarNativeExecutor.report = func(err error) { log.Print("任务栏原生清理失败: ", err) }
	b.taskbarNativeExecutor.post = func() error {
		ok, _, _ := taskbarPostMessage.Call(b.hwnd, b.resumeMessage, b.id, 0)
		if ok == 0 {
			return errors.New("PostMessage taskbar drain failed")
		}
		return nil
	}
	fail := func(err error) (taskbarBackend, error) {
		cleanup := b.close()
		if record.observer == b {
			record.observer = previous
		}
		return nil, errors.Join(err, cleanup)
	}
	hr, _, _ := taskbarCoInit.Call(0, 2)
	if err := taskbarHRESULT("CoInitializeEx", hr); err != nil {
		return fail(err)
	}
	b.comInitialized = true
	hr, _, _ = taskbarCoCreate.Call(uintptr(unsafe.Pointer(&taskbarCLSID)), 0, 1, uintptr(unsafe.Pointer(&taskbarIID)), uintptr(unsafe.Pointer(&b.object)))
	if err := taskbarHRESULT("CoCreateInstance", hr); err != nil {
		return fail(err)
	}
	if err := b.invokeCOM(3); err != nil {
		return fail(err)
	}
	for _, registration := range []struct {
		name   string
		target *uintptr
	}{
		{"TaskbarButtonCreated", &b.message}, {"HEMusic.TaskbarDrain", &b.resumeMessage},
	} {
		name, _ := syscall.UTF16PtrFromString(registration.name)
		*registration.target, _, _ = taskbarRegisterMessage.Call(uintptr(unsafe.Pointer(name)))
		if *registration.target == 0 {
			return fail(errors.New("RegisterWindowMessage failed"))
		}
	}
	for i := range b.icons {
		icon, err := newTaskbarIcon(i)
		if err != nil {
			return fail(err)
		}
		b.icons[i] = icon
	}
	taskbarHooks[b.id] = b
	if taskbarSubclassCallback == 0 {
		taskbarSubclassCallback = syscall.NewCallback(taskbarSubclassProc)
	}
	ok, _, _ := taskbarSetSubclass.Call(hwnd, taskbarSubclassCallback, b.id, 0)
	if ok == 0 {
		delete(taskbarHooks, b.id)
		return fail(errors.New("SetWindowSubclass failed"))
	}
	b.hooked = true
	// Both failed removals stay tracked by the record, even after fail restores
	// the old observer and releases the failed constructor's COM/icon resources.
	if previous != nil {
		if err := record.hooks.replace(previous, b); err != nil {
			return fail(err)
		}
	}
	return b, nil
}

func taskbarSubclassProc(hwnd, msg, wparam, lparam, id, ref uintptr) uintptr {
	b := taskbarHooks[id]
	if b != nil && b.hwnd == hwnd {
		switch {
		case msg == 0x82:
			if err := b.removeHook(); err != nil {
				log.Print("任务栏窗口钩子清理失败: ", err)
			}
			// HWND destruction is the final native lifetime boundary, even if an
			// explicit RemoveWindowSubclass just failed. Forget every retained owner.
			b.hookDestroyed()
			taskbarDestroyHookRecord(&b.record.hooks, taskbarWindows, hwnd, b.record)
			if err := b.close(); err != nil && err != errTaskbarQueued {
				log.Print("任务栏窗口清理失败: ", err)
			}
			b.rebuild()
		case msg == b.message:
			b.explorerCreated()
			if !b.closed && !b.deferredClose {
				b.rebuild()
			}
		case msg == b.resumeMessage && wparam == b.id:
			b.resume()
			return 0
		case !b.closed && msg == 0x111 && (wparam>>16)&0xffff == 0x1800 && lparam == 0:
			for i, button := range b.buttons {
				if uint32(wparam&0xffff) == button.ID && b.added {
					if b.active {
						b.click([]TaskbarAction{TaskbarPrevious, TaskbarToggle, TaskbarNext}[i])
					}
					return 0
				}
			}
		}
	}
	result, _, _ := taskbarDefSubclass.Call(hwnd, msg, wparam, lparam)
	return result
}

func (b *windowsTaskbar) removeHook() error {
	if b.hooked {
		ok, _, _ := taskbarRemoveSubclass.Call(b.hwnd, taskbarSubclassCallback, b.id)
		if ok == 0 {
			return errors.New("RemoveWindowSubclass failed")
		}
		b.hooked = false
	}
	delete(taskbarHooks, b.id)
	return nil
}

func (b *windowsTaskbar) hookDestroyed() {
	b.hooked = false
	delete(taskbarHooks, b.id)
}

func (b *windowsTaskbar) releaseNative() error {
	var errs []error
	// Keep only the HWND observer after close. It tracks Explorer recreation and
	// destruction, preserving Add/IDs across a live-window reopen without COM.
	for _, icon := range b.icons {
		if icon != 0 {
			ok, _, _ := taskbarDestroyIcon.Call(icon)
			if ok == 0 {
				errs = append(errs, errors.New("DestroyIcon failed"))
			}
		}
	}
	b.icons = [4]uintptr{}
	if b.object != nil {
		_ = b.invokeCOM(2)
		b.object = nil
	}
	if b.comInitialized {
		taskbarCoUninit.Call()
		b.comInitialized = false
	}
	return errors.Join(errs...)
}

func newTaskbarIcon(kind int) (uintptr, error) {
	var and, xor [32]byte
	for i := range and {
		and[i] = 0xff
	}
	for y := 3; y < 13; y++ {
		for x := 3; x < 13; x++ {
			distance := y - 7
			if distance < 0 {
				distance = -distance
			}
			draw := false
			switch kind {
			case 0:
				draw = x == 3 || x >= 5+distance && x <= 12
			case 1:
				draw = x >= 4 && x <= 12-distance*2
			case 2:
				draw = x <= 5 || x >= 10
			case 3:
				draw = x == 12 || x >= 3 && x <= 10-distance
			}
			if draw {
				offset := y*2 + x/8
				bit := byte(0x80 >> uint(x%8))
				and[offset] &= ^bit
				xor[offset] |= bit
			}
		}
	}
	icon, _, _ := taskbarCreateIcon.Call(0, 16, 16, 1, 1, uintptr(unsafe.Pointer(&and[0])), uintptr(unsafe.Pointer(&xor[0])))
	if icon == 0 {
		return 0, errors.New("CreateIcon failed")
	}
	return icon, nil
}
