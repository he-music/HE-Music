package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

func buildMpvTestLibrary(t *testing.T, flags ...string) string {
	t.Helper()
	compiler, err := exec.LookPath("cc")
	if err != nil {
		t.Skip("隔离 C ABI 测试需要 C 编译器")
	}
	name := "libtestmpv.so"
	if runtime.GOOS == "darwin" {
		name = "libtestmpv.dylib"
	}
	if runtime.GOOS == "windows" {
		name = "testmpv.dll"
	}
	path := filepath.Join(t.TempDir(), name)
	args := []string{"-std=c11", "-shared", "-fPIC", "testdata/mpv_client.c", "-o", path}
	if runtime.GOOS == "darwin" {
		args[1] = "-dynamiclib"
	}
	args = append(args, flags...)
	if output, err := exec.CommandContext(t.Context(), compiler, args...).CombinedOutput(); err != nil {
		t.Fatalf("构建隔离库: %v\n%s", err, output)
	}
	return path
}

func TestMpvLoaderClassifiedFailuresAndABI(t *testing.T) {
	var loader mpvLibrary
	for _, path := range []string{"libmpv.so", filepath.Join(t.TempDir(), "missing"), t.TempDir()} {
		if _, err := loader.load(path); err == nil || mpvFailureOf(err).Kind != "library" {
			t.Fatalf("缺库/相对路径没有分类: %q %v", path, err)
		}
	}
	invalid := filepath.Join(t.TempDir(), "invalid")
	requireTestNoError(t, os.WriteFile(invalid, []byte("not a library"), 0o600))
	if _, err := loader.load(invalid); err == nil || mpvFailureOf(err).Kind != "library" {
		t.Fatalf("无效二进制: %v", err)
	}
	for _, test := range []struct {
		flag string
		kind MpvFailureKind
	}{{"-DTEST_API_VERSION=0x20005UL", "abi"}, {"-DTEST_API_VERSION=0x30000UL", "abi"}, {"-DTEST_MISSING_WAIT=1", "symbol"}} {
		if _, err := loader.load(buildMpvTestLibrary(t, test.flag)); err == nil || mpvFailureOf(err).Kind != test.kind {
			t.Fatalf("%s: %v", test.flag, err)
		}
	}
	path := buildMpvTestLibrary(t)
	api, err := loader.load(path)
	requireTestNoError(t, err)
	again, err := loader.load(path)
	requireTestNoError(t, err)
	if api != again {
		t.Fatal("重复加载没有复用同一绑定")
	}
	if _, err := loader.load(buildMpvTestLibrary(t)); err == nil {
		t.Fatal("允许替换已加载库")
	}
}

func TestMpvCABICommandNodeAndEventLifetime(t *testing.T) {
	var library mpvLibrary
	api, err := library.load(buildMpvTestLibrary(t))
	requireTestNoError(t, err)
	if unsafe.Sizeof(mpvNode{}) != 16 || unsafe.Sizeof(mpvNativeEvent{}) != 24 || unsafe.Sizeof(mpvNativeEnd{}) != 32 || unsafe.Offsetof(mpvNodeList{}.values) != 8 {
		t.Fatal("Go C ABI 布局错误")
	}
	handle := api.create()
	defer api.terminateDestroy(handle)
	requireTestNoError(t, mpvResult("initialize", api.initialize(handle)))
	devices, err := api.devices(handle)
	requireTestNoError(t, err)
	if len(devices) != 2 || devices[1].ID != "coreaudio/test" || devices[1].Label != "测试输出" {
		t.Fatalf("node 复制: %+v", devices)
	}
	_, err = api.devices(handle)
	requireTestNoError(t, err)
	if devices[1].Label != "测试输出" {
		t.Fatal("node 释放污染 Go 快照")
	}
	requireTestNoError(t, api.run(handle, "loadfile", "http://127.0.0.1/synthetic", "replace"))
	first := *api.waitEvent(handle, 0)
	entry := *(*int64)(first.data)
	_ = api.waitEvent(handle, 0)
	if first.id != 6 || entry != 1 {
		t.Fatalf("跨 WaitEvent 事件复制失败: %+v %d", first, entry)
	}
	if err := api.run(handle, "loadfile", "bad\x00value", "replace"); err == nil {
		t.Fatal("未拒绝 NUL")
	}
}

type mpvFixture struct {
	player *MpvPlayback
	flags  func(uintptr, int32, int32, int32, int32)
	end    func(uintptr, int32, int64)
	events []MpvEvent
}

func newMpvFixture(t *testing.T) *mpvFixture {
	t.Helper()
	path := buildMpvTestLibrary(t)
	var library mpvLibrary
	api, err := library.load(path)
	requireTestNoError(t, err)
	native, err := openMpvLibrary(path)
	requireTestNoError(t, err)
	t.Cleanup(func() { closeMpvLibrary(native) })
	fixture := &mpvFixture{player: &MpvPlayback{checkOwner: func(ctx context.Context) error { return ctx.Err() }}}
	purego.RegisterLibFunc(&fixture.flags, native, "test_mpv_flags")
	purego.RegisterLibFunc(&fixture.end, native, "test_mpv_end")
	ctx := t.Context()
	s := &fixture.player.session
	s.api, s.handle, s.owner = api, api.create(), ctx
	s.runContext, s.cancel = context.WithCancel(ctx)
	s.snapshot = MpvSnapshot{Lifecycle: 1, Rate: 1, Volume: 1, Device: "auto", State: "idle"}
	s.entry = -1
	s.emit = func(event MpvEvent) { fixture.events = append(fixture.events, event) }
	fixture.player.createResource = func(ctx, _ context.Context, _ MpvLoadRequest) (*mpvResource, error) {
		run, cancel := context.WithCancel(ctx)
		return &mpvResource{ctx: run, cancel: cancel, url: "http://127.0.0.1/synthetic"}, nil
	}
	t.Cleanup(func() { s.mu.Lock(); s.destroyLocked(); s.mu.Unlock() })
	return fixture
}

func (fixture *mpvFixture) drain() {
	s := &fixture.player.session
	s.mu.Lock()
	defer s.mu.Unlock()
	s.drainLocked(true)
}

func TestMpvLoadPauseSeekVolumeRateAndNaturalEOF(t *testing.T) {
	fixture := newMpvFixture(t)
	p, ctx := fixture.player, t.Context()
	loaded, err := p.Load(ctx, 1, MpvLoadRequest{Format: "wav", AutoPlay: true, Start: 2})
	requireTestNoError(t, err)
	fixture.drain()
	s := &p.session
	if s.snapshot.State != "playing" || !s.intent || !s.loaded {
		t.Fatalf("加载丢失自动播放意图: %+v", s.snapshot)
	}
	position, err := s.api.number(s.handle, "time-pos")
	requireTestNoError(t, err)
	if position != 2 {
		t.Fatalf("起播 seek: %v", position)
	}
	requireTestNoError(t, p.Pause(ctx, 1, loaded.Session))
	requireTestNoError(t, p.Seek(ctx, 1, loaded.Session, 4))
	fixture.drain()
	requireTestNoError(t, p.SetVolume(ctx, 1, loaded.Session, 0.3))
	requireTestNoError(t, p.SetRate(ctx, 1, loaded.Session, 1.5))
	if s.snapshot.State != "paused" || s.snapshot.Volume != 0.3 || s.snapshot.Rate != 1.5 {
		t.Fatalf("控制状态: %+v", s.snapshot)
	}
	fixture.end(s.handle, 0, s.entry-1)
	fixture.drain()
	if s.snapshot.State == "ended" {
		t.Fatal("旧条目 EOF 结束了新音源")
	}
	fixture.end(s.handle, 0, s.entry)
	fixture.drain()
	if s.snapshot.State != "ended" {
		t.Fatal("自然 EOF 丢失")
	}
	stopped, err := p.ClearSource(ctx, 1, loaded.Session)
	requireTestNoError(t, err)
	if stopped.Session <= loaded.Session || s.resource != nil {
		t.Fatal("清源未递增代次或释放资源")
	}
	if err := p.Play(ctx, 1, loaded.Session); !errors.Is(err, context.Canceled) {
		t.Fatalf("旧代次命令未取消: %v", err)
	}
	count := 0
	for _, event := range fixture.events {
		if event.Type == "ended" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("stop/旧 EOF 被误报: %d", count)
	}
}

func TestMpvLoadCancellationAndLatestIntent(t *testing.T) {
	fixture := newMpvFixture(t)
	p, ctx := fixture.player, t.Context()
	entered, release := make(chan struct{}), make(chan struct{})
	p.createResource = func(run, _ context.Context, _ MpvLoadRequest) (*mpvResource, error) {
		close(entered)
		<-release
		child, cancel := context.WithCancel(run)
		return &mpvResource{ctx: child, cancel: cancel, url: "http://127.0.0.1/synthetic"}, nil
	}
	done := make(chan error, 1)
	go func() { _, err := p.Load(ctx, 1, MpvLoadRequest{Format: "flac", AutoPlay: true}); done <- err }()
	<-entered
	s := &p.session
	s.mu.Lock()
	generation := s.snapshot.Session
	s.mu.Unlock()
	requireTestNoError(t, p.Pause(ctx, 1, generation))
	requireTestNoError(t, p.Seek(ctx, 1, generation, 7))
	close(release)
	requireTestNoError(t, <-done)
	fixture.drain()
	if s.snapshot.State != "paused" || s.start != 7 {
		t.Fatalf("加载期间暂停/seek 意图被覆盖: %+v %v", s.snapshot, s.start)
	}
	entered, release = make(chan struct{}), make(chan struct{})
	go func() { _, err := p.Load(ctx, 1, MpvLoadRequest{Format: "flac", AutoPlay: true}); done <- err }()
	<-entered
	s.mu.Lock()
	generation = s.snapshot.Session
	s.mu.Unlock()
	_, err := p.Stop(ctx, 1, generation)
	requireTestNoError(t, err)
	close(release)
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("stop 没有取消加载: %v", err)
	}
	loads, err := s.api.number(s.handle, "test-loads")
	requireTestNoError(t, err)
	if loads != 1 {
		t.Fatalf("取消后仍调用 loadfile: %v", loads)
	}
}

func TestMpvDevicesFailWithoutFallback(t *testing.T) {
	fixture := newMpvFixture(t)
	p, ctx := fixture.player, t.Context()
	s := &p.session
	requireTestNoError(t, p.SetOutputDevice(ctx, 1, "coreaudio/test"))
	if err := p.SetOutputDevice(ctx, 1, "coreaudio/missing"); err == nil || mpvFailureOf(err).Kind != "device" {
		t.Fatalf("缺失设备伪装成功: %v", err)
	}
	if s.snapshot.Device != "coreaudio/missing" || s.snapshot.State != "error" || s.intent {
		t.Fatalf("失败后偷偷恢复旧设备: %+v", s.snapshot)
	}
	fixture.flags(s.handle, 0, 0, 1, 0)
	if err := p.SetOutputDevice(ctx, 1, "coreaudio/test"); err == nil || mpvFailureOf(err).Kind != "device" {
		t.Fatalf("设备属性错误伪装成功: %v", err)
	}
	fixture.flags(s.handle, 0, 0, 0, 1)
	if _, err := p.GetOutputDevices(ctx, 1); err == nil {
		t.Fatal("设备枚举失败伪装成功")
	}
	fixture.flags(s.handle, 0, 0, 0, 0)
	requireTestNoError(t, p.SetOutputDevice(ctx, 1, "coreaudio/test"))
	loaded, err := p.Load(ctx, 1, MpvLoadRequest{Format: "wav", AutoPlay: true})
	requireTestNoError(t, err)
	fixture.drain()
	fixture.flags(s.handle, 1, 0, 0, 0)
	if err := p.Play(ctx, 1, loaded.Session); err == nil {
		t.Fatal("设备失效仍恢复播放")
	}
	paused, err := s.api.flag(s.handle, "pause")
	requireTestNoError(t, err)
	if !paused || s.intent {
		t.Fatal("设备失效没有暂停")
	}
}

func TestMpvEventQueueDoesNotBlockAndRejectsOldSessions(t *testing.T) {
	entered, release, received := make(chan struct{}), make(chan struct{}), make(chan MpvEvent, 8)
	var queue *mpvEventQueue
	var once sync.Once
	queue = newMpvEventQueue(t.Context(), func(event MpvEvent) {
		once.Do(func() { close(entered); <-release })
		if queue.current(event) {
			received <- event
		}
	})
	defer queue.cancel()
	queue.push(MpvEvent{Type: "ended", Snapshot: MpvSnapshot{Session: 1}})
	<-entered
	for range 1000 {
		queue.push(MpvEvent{Type: "timeupdate", Snapshot: MpvSnapshot{Session: 1}})
	}
	queue.push(MpvEvent{Type: "loadstart", Snapshot: MpvSnapshot{Session: 2}})
	queue.push(MpvEvent{Type: "loadedmetadata", Snapshot: MpvSnapshot{Session: 2}})
	close(release)
	for range 2 {
		select {
		case event := <-received:
			if event.Snapshot.Session != 2 {
				t.Fatalf("旧事件漏出: %+v", event)
			}
		case <-time.After(time.Second):
			t.Fatal("队列阻塞")
		}
	}
	queue.cancel()
	queue.push(MpvEvent{Type: "ended", Snapshot: MpvSnapshot{Session: 2}})
	if queue.current(MpvEvent{Snapshot: MpvSnapshot{Session: 2}}) {
		t.Fatal("撤销后仍授权旧队列")
	}
}

func TestMpvDemuxerRejectsSecondaryResources(t *testing.T) {
	for _, format := range []string{"m3u8", "hls", "dash", "concat", "sdp", "ffconcat", "file://x"} {
		if _, err := mpvDemuxer(format); err == nil {
			t.Fatalf("允许二级资源 %q", format)
		}
	}
	for _, format := range []string{"dsf", "dff", "ape", "flac", "wav", "mp3"} {
		if _, err := mpvDemuxer(format); err != nil {
			t.Fatalf("拒绝独立音频 %q: %v", format, err)
		}
	}
	for extension := range localAudioExtensions {
		if _, err := mpvDemuxer(extension); err != nil {
			t.Errorf("扫描支持的容器不能被 mpv 拒绝 %q: %v", extension, err)
		}
	}
	for format, expected := range map[string]string{"dff": "iff", "webm": "matroska", "matroska": "matroska"} {
		if actual, err := mpvDemuxer(format); err != nil || actual != expected {
			t.Errorf("容器 %q: got %q (%v), want %q", format, actual, err, expected)
		}
	}
}

func TestMpvRevokeNeverWaitsForSessionMutexOrDestroysReplacement(t *testing.T) {
	fixture := newMpvFixture(t)
	p, s := fixture.player, &fixture.player.session
	old := newMpvEventQueue(t.Context(), func(MpvEvent) {})
	defer old.cancel()
	s.mu.Lock()
	s.queue = old
	p.active.Store(old)
	done := make(chan struct{})
	go func() { p.revoke(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		s.mu.Unlock()
		t.Fatal("主线程撤销等待会话锁，可能与事件调度死锁")
	}
	replacement := newMpvEventQueue(t.Context(), func(MpvEvent) {})
	defer replacement.cancel()
	s.queue = replacement
	p.active.Store(replacement)
	s.mu.Unlock()
	// 确定性执行旧清理路径，验证它不能销毁新队列拥有的句柄。
	p.retire(old)
	s.mu.Lock()
	if s.handle == 0 || s.queue != replacement {
		t.Error("旧撤销清理了新实例")
	}
	s.mu.Unlock()
}

func TestMpvReplacementLoadCancelsEarlierResolution(t *testing.T) {
	fixture := newMpvFixture(t)
	p, s, ctx := fixture.player, &fixture.player.session, t.Context()
	entered, release := make(chan struct{}), make(chan struct{})
	p.createResource = func(run, _ context.Context, request MpvLoadRequest) (*mpvResource, error) {
		if request.URL == "first" {
			close(entered)
			<-release
		}
		child, cancel := context.WithCancel(run)
		return &mpvResource{ctx: child, cancel: cancel, url: "http://127.0.0.1/synthetic"}, nil
	}
	done := make(chan error, 1)
	go func() {
		_, err := p.Load(ctx, 1, MpvLoadRequest{URL: "first", Format: "wav", AutoPlay: true})
		done <- err
	}()
	<-entered
	current, err := p.Load(ctx, 1, MpvLoadRequest{URL: "second", Format: "wav"})
	requireTestNoError(t, err)
	close(release)
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("旧解析没有取消: %v", err)
	}
	fixture.drain()
	if s.snapshot.Source != "second" || s.snapshot.Session != current.Session || s.snapshot.State != "paused" {
		t.Fatalf("旧解析覆盖新源: %+v", s.snapshot)
	}
	if err := p.Play(ctx, 1, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("零代次绕过隔离: %v", err)
	}
}

func TestMpvPauseFailureDestroysOutput(t *testing.T) {
	fixture := newMpvFixture(t)
	p, s, ctx := fixture.player, &fixture.player.session, t.Context()
	loaded, err := p.Load(ctx, 1, MpvLoadRequest{Format: "wav", AutoPlay: true})
	requireTestNoError(t, err)
	fixture.drain()
	fixture.flags(s.handle, 0, 1, 0, 0)
	if err := p.Pause(ctx, 1, loaded.Session); err == nil {
		t.Fatal("暂停错误伪装成功")
	}
	if s.handle != 0 || s.resource != nil || s.snapshot.State != "error" {
		t.Fatalf("暂停失败留下原生输出: %+v", s.snapshot)
	}
}

func TestMpvPollingPausesWhenExplicitDeviceDisappears(t *testing.T) {
	fixture := newMpvFixture(t)
	p, s, ctx := fixture.player, &fixture.player.session, t.Context()
	requireTestNoError(t, p.SetOutputDevice(ctx, 1, "coreaudio/test"))
	_, err := p.Load(ctx, 1, MpvLoadRequest{Format: "wav", AutoPlay: true})
	requireTestNoError(t, err)
	fixture.drain()
	failed := make(chan MpvEvent, 1)
	s.mu.Lock()
	s.emit = func(event MpvEvent) {
		if event.Type == "error" {
			select {
			case failed <- event:
			default:
			}
		}
	}
	fixture.flags(s.handle, 1, 0, 0, 0)
	s.mu.Unlock()
	run, cancel := context.WithCancel(ctx)
	defer cancel()
	go s.poll(run)
	select {
	case event := <-failed:
		if event.Snapshot.Error == nil || event.Snapshot.Error.Kind != "device" || event.Snapshot.Device != "coreaudio/test" {
			t.Fatalf("设备失效事件: %+v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("进度轮询没有发现已拔出设备")
	}
	s.mu.Lock()
	paused, err := s.api.flag(s.handle, "pause")
	s.mu.Unlock()
	requireTestNoError(t, err)
	if !paused {
		t.Fatal("指定设备消失后仍播放")
	}
}

func TestMpvStopWaitsForNativeIdleBeforeClosingFile(t *testing.T) {
	fixture := newMpvFixture(t)
	p, s, ctx := fixture.player, &fixture.player.session, t.Context()
	loaded, err := p.Load(ctx, 1, MpvLoadRequest{Format: "wav"})
	requireTestNoError(t, err)
	fixture.drain()
	file, err := os.CreateTemp(t.TempDir(), "synthetic-reader")
	requireTestNoError(t, err)
	s.resource.file = file
	original := s.api.getProperty
	var idle atomic.Bool
	entered := make(chan struct{})
	var once sync.Once
	s.api.getProperty = func(handle uintptr, name string, format int32, out unsafe.Pointer) int32 {
		if name == "idle-active" {
			once.Do(func() { close(entered) })
			value := int32(0)
			if idle.Load() {
				value = 1
			}
			*(*int32)(out) = value
			return 0
		}
		return original(handle, name, format, out)
	}
	done := make(chan error, 1)
	go func() {
		_, err := p.Stop(ctx, 1, loaded.Session)
		done <- err
	}()
	<-entered
	if _, err := file.Stat(); err != nil {
		t.Fatalf("stop 仅受理便提前关闭读者: %v", err)
	}
	select {
	case err := <-done:
		t.Fatalf("原生尚未 idle，stop 已返回: %v", err)
	default:
	}
	idle.Store(true)
	select {
	case err := <-done:
		requireTestNoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("原生 idle 后 stop 未收敛")
	}
	if _, err := file.Stat(); err == nil {
		t.Fatal("确认 idle 后仍持有文件读者")
	}
}
