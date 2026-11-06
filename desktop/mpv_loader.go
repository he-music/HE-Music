package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// ABI 依据 mpv v0.42.0 include/mpv/client.h（客户端 API 2.6）核对。
// 本最小绑定按需加载，避免 go-mpv 在 init 中加载失败并 panic。
const mpvClientAPIVersion = uint32(2<<16 | 6)

type MpvFailure struct {
	Kind    MpvFailureKind `json:"kind"`
	Message string         `json:"message"`
}

func (e *MpvFailure) Error() string { return string(e.Kind) + ": " + e.Message }

func mpvFail(kind MpvFailureKind, message string) error {
	return &MpvFailure{Kind: kind, Message: message}
}

func mpvResult(operation string, result int32) error {
	if result >= 0 {
		return nil
	}
	return mpvFail("engine", fmt.Sprintf("%s: libmpv error %d", operation, result))
}

type mpvAPI struct {
	clientAPIVersion  func() uintptr // C unsigned long，版本仅使用低 32 位。
	create            func() uintptr
	initialize        func(uintptr) int32
	terminateDestroy  func(uintptr)
	command           func(uintptr, **byte) int32
	setOptionString   func(uintptr, string, string) int32
	setPropertyString func(uintptr, string, string) int32
	getProperty       func(uintptr, string, int32, unsafe.Pointer) int32
	freeNodeContents  func(*mpvNode)
	waitEvent         func(uintptr, float64) *mpvNativeEvent
}

type mpvLibrary struct {
	sync.Mutex
	api  *mpvAPI
	path string
}

var bundledMpvLibrary mpvLibrary

func (l *mpvLibrary) load(path string) (*mpvAPI, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return nil, mpvFail("library", "libmpv requires an absolute bundled resource path")
	}
	l.Lock()
	defer l.Unlock()
	if l.api != nil {
		if l.path != path {
			return nil, mpvFail("library", "a different libmpv is already loaded")
		}
		return l.api, nil
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, mpvFail("library", "bundled libmpv is missing")
	}
	handle, err := openMpvLibrary(path)
	if err != nil {
		return nil, mpvFail("library", "cannot load bundled libmpv or its dependencies: "+err.Error())
	}
	api, err := registerMpvAPI(handle)
	if err != nil {
		closeMpvLibrary(handle)
		return nil, err
	}
	if err := validateMpvABI(uint32(api.clientAPIVersion())); err != nil {
		closeMpvLibrary(handle)
		return nil, err
	}
	// 库在进程生命周期内常驻。实例退出时销毁；不能卸载仍由 purego 函数引用的代码。
	l.api, l.path = api, path
	return api, nil
}

func validateMpvABI(version uint32) error {
	if version>>16 != 2 || version < mpvClientAPIVersion {
		return mpvFail("abi", fmt.Sprintf("unsupported libmpv client API %d.%d; need 2.6", version>>16, version&0xffff))
	}
	return nil
}

func registerMpvAPI(handle uintptr) (api *mpvAPI, err error) {
	api = &mpvAPI{}
	defer func() {
		if failure := recover(); failure != nil {
			api = nil
			err = mpvFail("symbol", fmt.Sprintf("libmpv symbol registration: %v", failure))
		}
	}()
	purego.RegisterLibFunc(&api.clientAPIVersion, handle, "mpv_client_api_version")
	purego.RegisterLibFunc(&api.create, handle, "mpv_create")
	purego.RegisterLibFunc(&api.initialize, handle, "mpv_initialize")
	purego.RegisterLibFunc(&api.terminateDestroy, handle, "mpv_terminate_destroy")
	purego.RegisterLibFunc(&api.command, handle, "mpv_command")
	purego.RegisterLibFunc(&api.setOptionString, handle, "mpv_set_option_string")
	purego.RegisterLibFunc(&api.setPropertyString, handle, "mpv_set_property_string")
	purego.RegisterLibFunc(&api.getProperty, handle, "mpv_get_property")
	purego.RegisterLibFunc(&api.freeNodeContents, handle, "mpv_free_node_contents")
	purego.RegisterLibFunc(&api.waitEvent, handle, "mpv_wait_event")
	return api, nil
}

func (a *mpvAPI) run(handle uintptr, values ...string) error {
	buffers := make([][]byte, len(values))
	refs := make([]*byte, len(values)+1)
	for index, value := range values {
		if strings.ContainsRune(value, 0) {
			return mpvFail("source", "command contains NUL")
		}
		buffers[index] = append([]byte(value), 0)
		refs[index] = &buffers[index][0]
	}
	result := a.command(handle, &refs[0])
	runtime.KeepAlive(buffers)
	runtime.KeepAlive(refs)
	return mpvResult(values[0], result)
}

// 分发目标均为 64 位。mpv_node 的 union 占 8 字节，此绑定仅读取其中的 string/list 指针成员。
// mpv_node_list 以 int 和对齐填充起始。
type mpvNode struct {
	data    unsafe.Pointer
	format  int32
	padding int32
}
type mpvNodeList struct {
	count   int32
	padding int32
	values  *mpvNode
	keys    **byte
}
type mpvNativeEvent struct {
	id   int32
	_    int32
	_    uint64
	data unsafe.Pointer
}
type mpvNativeEnd struct {
	reason   int32
	code     int32
	entry    int64
	insertID int64
	inserts  int32
}

func mpvString(pointer *byte) string {
	if pointer == nil {
		return ""
	}
	var result []byte
	for index := range 1 << 20 {
		value := *(*byte)(unsafe.Add(unsafe.Pointer(pointer), index))
		if value == 0 {
			return string(result)
		}
		result = append(result, value)
	}
	return ""
}

func (a *mpvAPI) number(handle uintptr, property string) (float64, error) {
	var value float64
	err := mpvResult(property, a.getProperty(handle, property, 5, unsafe.Pointer(&value)))
	return value, err
}

func (a *mpvAPI) flag(handle uintptr, property string) (bool, error) {
	var value int32
	err := mpvResult(property, a.getProperty(handle, property, 3, unsafe.Pointer(&value)))
	return value != 0, err
}

func (a *mpvAPI) devices(handle uintptr) ([]MpvOutputDevice, error) {
	var node mpvNode
	if err := mpvResult("audio-device-list", a.getProperty(handle, "audio-device-list", 6, unsafe.Pointer(&node))); err != nil {
		return nil, err
	}
	defer a.freeNodeContents(&node)
	return copyMpvDevices(node)
}

func copyMpvDevices(node mpvNode) ([]MpvOutputDevice, error) {
	if node.format != 7 || node.data == nil {
		return nil, mpvFail("device", "invalid audio-device-list")
	}
	list := (*mpvNodeList)(node.data)
	if list.count < 0 || list.count > 4096 || list.count > 0 && list.values == nil {
		return nil, mpvFail("device", "invalid device count")
	}
	devices := make([]MpvOutputDevice, 0, list.count)
	for _, item := range unsafe.Slice(list.values, list.count) {
		if item.format != 8 || item.data == nil {
			return nil, mpvFail("device", "invalid device entry")
		}
		fields := (*mpvNodeList)(item.data)
		if fields.count < 0 || fields.count > 64 || fields.count > 0 && (fields.values == nil || fields.keys == nil) {
			return nil, mpvFail("device", "invalid device fields")
		}
		values, keys := unsafe.Slice(fields.values, fields.count), unsafe.Slice(fields.keys, fields.count)
		device := MpvOutputDevice{Available: true}
		for index, key := range keys {
			if values[index].format != 1 {
				continue
			}
			value := mpvString((*byte)(values[index].data))
			switch mpvString(key) {
			case "name":
				device.ID = value
			case "description":
				device.Label = value
			}
		}
		if device.ID == "" {
			return nil, mpvFail("device", "missing device ID")
		}
		devices = append(devices, device)
	}
	return devices, nil
}

func mpvFailureOf(err error) *MpvFailure {
	if failure, ok := errors.AsType[*MpvFailure](err); ok {
		return failure
	}
	if err == nil {
		return nil
	}
	return &MpvFailure{Kind: "engine", Message: err.Error()}
}
