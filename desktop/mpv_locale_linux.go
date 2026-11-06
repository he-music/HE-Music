//go:build linux

package main

import (
	"sync"

	"github.com/ebitengine/purego"
)

// GTK 启动时会设置 libc 区域。libmpv 在 mpv_create 中检查 LC_NUMERIC，
// 即使 zh_CN 等区域使用小数点也会拒绝。修改环境变量不会更新已经初始化的 libc。
// 只固定数字解析区域，保留消息语言等其他区域；mpv 存活期间不能恢复旧值。
var prepareMpvNumericLocale = sync.OnceValue(func() error {
	address, err := purego.Dlsym(purego.RTLD_DEFAULT, "setlocale")
	if err != nil {
		return mpvFail("engine", "cannot resolve numeric locale setup: "+err.Error())
	}
	var setLocale func(int32, string) uintptr
	purego.RegisterFunc(&setLocale, address)
	const lcNumeric = 1 // Linux libc 的 LC_NUMERIC。
	if setLocale(lcNumeric, "C") == 0 {
		return mpvFail("engine", "cannot set C numeric locale for libmpv")
	}
	return nil
})
