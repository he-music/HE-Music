//go:build linux

package main

import (
	"context"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/ebitengine/purego"
)

func TestMpvInitializeWithNonCNumericLocale(t *testing.T) {
	const (
		localeEnv  = "HE_MUSIC_TEST_MPV_NUMERIC_LOCALE"
		lcAll      = 6
		lcNumeric  = 1
		lcMessages = 5
	)
	selected := os.Getenv(localeEnv)
	if selected == "" {
		for _, name := range []string{"C.utf8", "zh_CN.UTF-8", "de_DE.UTF-8"} {
			t.Run(name, func(t *testing.T) {
				command := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestMpvInitializeWithNonCNumericLocale$", "-test.v")
				command.Env = append(os.Environ(), localeEnv+"="+name)
				output, err := command.CombinedOutput()
				if err != nil {
					t.Fatalf("非 C 区域初始化失败: %v\n%s", err, output)
				}
				t.Log(strings.TrimSpace(string(output)))
			})
		}
		return
	}

	// libc 区域设置是进程状态；在独立子进程中模拟 GTK 初始化后的状态。
	var setLocale func(int32, *byte) *byte
	purego.RegisterLibFunc(&setLocale, purego.RTLD_DEFAULT, "setlocale")
	name := append([]byte(selected), 0)
	if setLocale(lcAll, &name[0]) == nil {
		t.Skipf("系统未安装 %s", selected)
	}
	messages := mpvString(setLocale(lcMessages, nil))
	numeric := func() string { return mpvString(setLocale(lcNumeric, nil)) }
	if numeric() == "C" || numeric() == "C.UTF-8" {
		t.Fatalf("未建立非 C 数字区域: %s", numeric())
	}

	api := &mpvAPI{
		create: func() uintptr {
			if numeric() != "C" && numeric() != "C.UTF-8" {
				return 0
			}
			return 1
		},
		setOptionString:  func(uintptr, string, string) int32 { return 0 },
		initialize:       func(uintptr) int32 { return 0 },
		terminateDestroy: func(uintptr) {},
	}
	libraryPath := os.Getenv("MPV_INTEGRATION_LIBRARY")
	if libraryPath != "" {
		var library mpvLibrary
		var err error
		api, err = library.load(libraryPath)
		requireTestNoError(t, err)
	}
	player := &MpvPlayback{checkOwner: func(ctx context.Context) error { return ctx.Err() }}
	session := &player.session
	requireTestNoError(t, session.initializeLocked(t.Context(), api, "null"))
	t.Cleanup(func() {
		session.mu.Lock()
		session.destroyLocked()
		session.mu.Unlock()
	})
	if libraryPath != "" {
		devices, err := player.GetOutputDevices(t.Context(), session.snapshot.Lifecycle)
		requireTestNoError(t, err)
		if !slices.ContainsFunc(devices, func(device MpvOutputDevice) bool { return device.ID == "auto" }) {
			t.Fatalf("缺少系统默认输出: %+v", devices)
		}
		requireTestNoError(t, player.SetOutputDevice(t.Context(), session.snapshot.Lifecycle, "auto"))
	}
	if numeric() != "C" {
		t.Fatalf("数字区域未固定为 C: %s", numeric())
	}
	if got := mpvString(setLocale(lcMessages, nil)); got != messages {
		t.Fatalf("修改了消息语言: %s -> %s", messages, got)
	}
}
