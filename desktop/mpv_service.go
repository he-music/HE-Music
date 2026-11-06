package main

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

type MpvOutputDevice struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
}

type MpvLoadRequest struct {
	URL       string        `json:"url"`
	Format    string        `json:"format"`
	FileEpoch uint64        `json:"fileEpoch"`
	LocalRef  *LocalFileRef `json:"localRef"`
	AutoPlay  bool          `json:"autoPlay"`
	Start     float64       `json:"start"`
}

type MpvSnapshot struct {
	Lifecycle uint64      `json:"lifecycle"`
	Session   uint64      `json:"session"`
	Sequence  uint64      `json:"sequence"`
	State     MpvState    `json:"state"`
	Position  float64     `json:"position"`
	Duration  float64     `json:"duration"`
	Rate      float64     `json:"rate"`
	Volume    float64     `json:"volume"`
	Source    string      `json:"source"`
	Device    string      `json:"device"`
	Error     *MpvFailure `json:"error"`
}

type MpvEvent struct {
	Type     MpvEventType `json:"type"`
	Snapshot MpvSnapshot  `json:"snapshot"`
}

var (
	desktopMpv      = &MpvPlayback{}
	desktopMpvEvent = mygo.NewEvent[MpvEvent]("desktop:mpv")
)

// 所有 C 调用（包括零超时 WaitEvent）均持有 mu；在下一次 WaitEvent 或销毁前
// 完成事件和 node 数据复制，原生裸指针不得跨调用保存。
type mpvSession struct {
	mu            sync.Mutex
	api           *mpvAPI
	handle        uintptr
	owner         context.Context
	stopOwner     func() bool
	cancel        context.CancelFunc
	snapshot      MpvSnapshot
	resource      *mpvResource
	entry         int64
	loaded        bool
	seeking       bool
	intent        bool
	awaitingPlay  bool
	start         float64
	emit          func(MpvEvent)
	queue         *mpvEventQueue
	runContext    context.Context
	pendingCancel context.CancelFunc
}

type MpvPlayback struct {
	session        mpvSession
	mu             sync.Mutex
	active         atomic.Pointer[mpvEventQueue]
	revision       atomic.Uint64
	checkOwner     func(context.Context) error
	createResource func(context.Context, context.Context, MpvLoadRequest) (*mpvResource, error)
}

func init() {
	mygo.Bind(desktopMpv)
	beforeLocalFileMutation = prepareMpvFileMutation
}

func (p *MpvPlayback) authorized(ctx context.Context) error {
	if p.checkOwner != nil {
		return p.checkOwner(ctx)
	}
	return desktopLifecycle.call(ctx, true, func() error { return nil })
}

// Initialize 仅解析应用资源路径；渲染进程不能指定动态库路径，绑定生成时不加载库。
func (p *MpvPlayback) Initialize(ctx context.Context) (MpvSnapshot, error) {
	revision := p.revision.Load()
	if err := p.authorized(ctx); err != nil {
		return MpvSnapshot{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.session.mu.Lock()
	if p.session.handle != 0 && p.session.owner == ctx && p.session.runContext.Err() == nil {
		value := p.session.snapshot
		p.session.mu.Unlock()
		return value, nil
	}
	p.session.destroyLocked()
	p.session.mu.Unlock()
	path, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return MpvSnapshot{}, mpvFail("library", "application resources unavailable")
	}
	name := "libmpv.so.2"
	if runtime.GOOS == "darwin" {
		name = "libmpv.2.dylib"
	}
	if runtime.GOOS == "windows" {
		name = "libmpv-2.dll"
	}
	api, err := bundledMpvLibrary.load(filepath.Join(path, "mpv", name))
	if err != nil {
		return MpvSnapshot{}, err
	}
	p.session.mu.Lock()
	defer p.session.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return MpvSnapshot{}, err
	}
	if p.revision.Load() != revision {
		return MpvSnapshot{}, context.Canceled
	}
	if err := p.session.initializeLocked(ctx, api, ""); err != nil {
		return MpvSnapshot{}, err
	}
	var queue *mpvEventQueue
	queue = newMpvEventQueue(p.session.runContext, func(value MpvEvent) {
		mygo.RunOnMain(func() {
			current := p.active.Load()
			l := desktopLifecycle
			if current != nil && current.current(value) && current == queue && l.state.owns(ctx) && l.main != nil && !l.main.IsDestroyed() {
				_ = desktopMpvEvent.EmitPage(l.main.Page(), value)
			}
		})
	})
	stopQueue, stopSession := queue.cancel, p.session.cancel
	queue.cancel = func() { stopQueue(); stopSession() }
	p.session.queue = queue
	p.session.emit = queue.push
	p.active.Store(queue)
	if p.revision.Load() != revision {
		queue.cancel()
		p.session.destroyLocked()
		return MpvSnapshot{}, context.Canceled
	}
	return p.session.snapshot, nil
}

func (s *mpvSession) initializeLocked(ctx context.Context, api *mpvAPI, testAO string) error {
	handle := api.create()
	if handle == 0 {
		return mpvFail("engine", "mpv_create failed")
	}
	options := [][2]string{
		{"config", "no"},
		{"load-scripts", "no"},
		{"ytdl", "no"},
		{"video", "no"},
		{"vo", "null"},
		{"terminal", "no"},
		{"osc", "no"},
		{"input-default-bindings", "no"},
		{"input-vo-keyboard", "no"},
		{"audio-display", "no"},
		{"sub-auto", "no"},
		{"audio-file-auto", "no"},
		{"access-references", "no"},
		{"load-unsafe-playlists", "no"},
		{"demuxer", "lavf"},
		{"demuxer-lavf-o", "protocol_whitelist=none"},
		{"audio-fallback-to-null", "no"},
		{"audio-client-name", "HE-Music"},
		{"pause", "yes"},
		{"idle", "yes"},
		{"keep-open", "no"},
	}
	if testAO != "" {
		options = append(options, [2]string{"ao", testAO})
	}
	for _, option := range options {
		if err := mpvResult(option[0], api.setOptionString(handle, option[0], option[1])); err != nil {
			api.terminateDestroy(handle)
			return err
		}
	}
	if err := mpvResult("initialize", api.initialize(handle)); err != nil {
		api.terminateDestroy(handle)
		return err
	}
	s.api, s.handle, s.owner = api, handle, ctx
	s.snapshot = MpvSnapshot{Lifecycle: s.snapshot.Lifecycle + 1, State: "idle", Rate: 1, Volume: 1, Device: "auto"}
	s.entry = -1
	runContext, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.runContext = runContext
	lifecycle := s.snapshot.Lifecycle
	s.stopOwner = context.AfterFunc(ctx, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.owner == ctx && s.snapshot.Lifecycle == lifecycle {
			s.destroyLocked()
		}
	})
	go s.poll(runContext)
	return nil
}

func (p *MpvPlayback) Load(ctx context.Context, lifecycle uint64, request MpvLoadRequest) (MpvSnapshot, error) {
	if err := p.authorized(ctx); err != nil {
		return MpvSnapshot{}, err
	}
	if !finiteMpv(request.Start) || request.Start < 0 {
		return MpvSnapshot{}, mpvFail("source", "invalid start position")
	}
	format, err := mpvDemuxer(request.Format)
	if err != nil {
		return MpvSnapshot{}, err
	}
	s := &p.session
	s.mu.Lock()
	if err := s.validLocked(ctx, lifecycle, 0); err != nil {
		s.mu.Unlock()
		return MpvSnapshot{}, err
	}
	s.snapshot.Session++
	generation := s.snapshot.Session
	if err := s.stopLocked(); err != nil {
		s.mu.Unlock()
		return MpvSnapshot{}, err
	}
	loadContext, cancel := context.WithCancel(s.runContext)
	s.pendingCancel = cancel
	s.intent, s.start = request.AutoPlay, request.Start
	s.snapshot.State, s.snapshot.Error = "loading", nil
	s.emitLocked("loadstart")
	s.mu.Unlock()
	create := p.createResource
	if create == nil {
		create = newMpvResource
	}
	resource, err := create(loadContext, ctx, request)
	if err != nil {
		s.mu.Lock()
		if s.snapshot.Session == generation && s.snapshot.Lifecycle == lifecycle && s.runContext.Err() == nil && loadContext.Err() == nil {
			s.failLocked(err)
		}
		s.mu.Unlock()
		return MpvSnapshot{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validLocked(ctx, lifecycle, generation); err != nil {
		resource.close()
		return MpvSnapshot{}, err
	}
	if err := resource.ctx.Err(); err != nil {
		resource.close()
		return MpvSnapshot{}, err
	}
	if err := s.deviceValidLocked(); err != nil {
		resource.close()
		s.failLocked(err)
		return MpvSnapshot{}, err
	}
	if err := mpvResult("format", s.api.setPropertyString(s.handle, "demuxer-lavf-format", format)); err != nil {
		resource.close()
		s.failLocked(err)
		return MpvSnapshot{}, err
	}
	if err := mpvResult("pause", s.api.setPropertyString(s.handle, "pause", "yes")); err != nil {
		resource.close()
		s.failLocked(err)
		return MpvSnapshot{}, err
	}
	s.resource = resource
	s.snapshot.Source = request.URL
	if request.LocalRef != nil {
		s.snapshot.Source = request.LocalRef.FileID
	}
	if err := s.api.run(s.handle, "loadfile", resource.url, "replace"); err != nil {
		_ = s.stopLocked()
		s.failLocked(err)
		return MpvSnapshot{}, err
	}
	return s.snapshot, nil
}

func (s *mpvSession) validLocked(ctx context.Context, lifecycle, session uint64) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if s.handle == 0 || s.owner != ctx || s.runContext.Err() != nil || s.snapshot.Lifecycle != lifecycle || session != 0 && s.snapshot.Session != session {
		return context.Canceled
	}
	return nil
}

func (p *MpvPlayback) Play(ctx context.Context, lifecycle, session uint64) error {
	return p.pause(ctx, lifecycle, session, false)
}

func (p *MpvPlayback) Pause(ctx context.Context, lifecycle, session uint64) error {
	return p.pause(ctx, lifecycle, session, true)
}

func (p *MpvPlayback) pause(ctx context.Context, lifecycle, session uint64, paused bool) error {
	if err := p.authorized(ctx); err != nil {
		return err
	}
	s := &p.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validLocked(ctx, lifecycle, session); err != nil {
		return err
	}
	if session != s.snapshot.Session {
		return context.Canceled
	}
	s.intent = !paused
	if !s.loaded {
		return nil
	}
	if !paused {
		if err := s.deviceValidLocked(); err != nil {
			s.failLocked(err)
			return err
		}
	}
	return s.pauseLocked(paused)
}

func (s *mpvSession) pauseLocked(paused bool) error {
	value := "no"
	if paused {
		value = "yes"
	}
	if err := mpvResult("pause", s.api.setPropertyString(s.handle, "pause", value)); err != nil {
		s.failLocked(err)
		return err
	}
	s.snapshot.State = "playing"
	kind := MpvEventPlay
	if paused {
		s.snapshot.State, kind = "paused", "pause"
	}
	s.emitLocked(kind)
	return nil
}

func (p *MpvPlayback) Stop(ctx context.Context, lifecycle, session uint64) (MpvSnapshot, error) {
	if err := p.authorized(ctx); err != nil {
		return MpvSnapshot{}, err
	}
	s := &p.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validLocked(ctx, lifecycle, session); err != nil {
		return MpvSnapshot{}, err
	}
	if session != s.snapshot.Session {
		return MpvSnapshot{}, context.Canceled
	}
	s.snapshot.Session++
	s.intent = false
	err := s.stopLocked()
	s.emitLocked("emptied")
	return s.snapshot, err
}

func (p *MpvPlayback) ClearSource(ctx context.Context, lifecycle, session uint64) (MpvSnapshot, error) {
	return p.Stop(ctx, lifecycle, session)
}

// stop 的同步返回仅代表命令受理；确认 idle-active 后才释放资源和目录租约。
// 超时则销毁实例，保证标签写入钩子绝不把命令受理误判为读者已释放。
func (s *mpvSession) stopLocked() error {
	if s.handle == 0 {
		return nil
	}
	if s.pendingCancel != nil {
		s.pendingCancel()
		s.pendingCancel = nil
	}
	s.intent = false
	if s.resource != nil {
		s.resource.cancel()
	}
	if err := s.api.run(s.handle, "stop"); err != nil {
		s.destroyLocked()
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		empty := s.drainLocked(false)
		idle, err := s.api.flag(s.handle, "idle-active")
		if err == nil && idle && empty && s.drainLocked(false) {
			break
		}
		if time.Now().After(deadline) {
			s.destroyLocked()
			return mpvFail("engine", "stop timed out; native player destroyed")
		}
		time.Sleep(time.Millisecond)
	}
	if s.resource != nil {
		s.resource.close()
		s.resource = nil
	}
	s.entry, s.loaded, s.seeking = -1, false, false
	s.snapshot.State, s.snapshot.Source, s.snapshot.Position, s.snapshot.Duration = "idle", "", 0, 0
	return nil
}

func (p *MpvPlayback) Seek(ctx context.Context, lifecycle, session uint64, seconds float64) error {
	if !finiteMpv(seconds) || seconds < 0 {
		return mpvFail("source", "invalid seek position")
	}
	return p.withSession(ctx, lifecycle, session, func(s *mpvSession) error {
		if !s.loaded {
			s.start = seconds
			return nil
		}
		s.seeking = true
		return s.api.run(s.handle, "seek", strconv.FormatFloat(seconds, 'f', 6, 64), "absolute+exact")
	})
}

func (p *MpvPlayback) SetVolume(ctx context.Context, lifecycle, session uint64, value float64) error {
	if !finiteMpv(value) || value < 0 || value > 1 {
		return mpvFail("engine", "invalid volume")
	}
	return p.withSession(ctx, lifecycle, session, func(s *mpvSession) error {
		if err := mpvResult("volume", s.api.setPropertyString(s.handle, "volume", strconv.FormatFloat(value*100, 'f', 6, 64))); err != nil {
			return err
		}
		s.snapshot.Volume = value
		s.emitLocked("volumechange")
		return nil
	})
}

func (p *MpvPlayback) SetRate(ctx context.Context, lifecycle, session uint64, value float64) error {
	if !finiteMpv(value) || value <= 0 || value > 8 {
		return mpvFail("engine", "invalid rate")
	}
	return p.withSession(ctx, lifecycle, session, func(s *mpvSession) error {
		if err := mpvResult("speed", s.api.setPropertyString(s.handle, "speed", strconv.FormatFloat(value, 'f', 6, 64))); err != nil {
			return err
		}
		s.snapshot.Rate = value
		s.emitLocked("ratechange")
		return nil
	})
}

func (p *MpvPlayback) GetOutputDevices(ctx context.Context, lifecycle uint64) ([]MpvOutputDevice, error) {
	var devices []MpvOutputDevice
	err := p.withLifecycle(ctx, lifecycle, func(s *mpvSession) error {
		var err error
		devices, err = s.api.devices(s.handle)
		if err != nil {
			return mpvFail("device", err.Error())
		}
		return nil
	})
	return devices, err
}

func (p *MpvPlayback) SetOutputDevice(ctx context.Context, lifecycle uint64, device string) error {
	if device == "" || strings.ContainsRune(device, 0) {
		return mpvFail("device", "invalid device")
	}
	return p.withLifecycle(ctx, lifecycle, func(s *mpvSession) error {
		s.snapshot.Device = device // 失败也保留新设备选择。
		s.intent = false
		if err := s.pauseLocked(true); err != nil {
			return err
		}
		if err := s.deviceValidLocked(); err != nil {
			s.failLocked(err)
			return err
		}
		// 将输出后端限制为指定设备所属后端，禁止失败后自动探测其他输出。
		ao := ""
		if device != "auto" {
			ao, _, _ = strings.Cut(device, "/")
		}
		if err := mpvResult("ao", s.api.setPropertyString(s.handle, "ao", ao)); err != nil {
			s.failLocked(mpvFail("device", err.Error()))
			return mpvFail("device", err.Error())
		}
		if err := mpvResult("audio-device", s.api.setPropertyString(s.handle, "audio-device", device)); err != nil {
			failure := mpvFail("device", err.Error())
			s.failLocked(failure)
			return failure
		}
		s.snapshot.Error = nil
		s.emitLocked("deviceschange")
		return nil
	})
}

func (s *mpvSession) deviceValidLocked() error {
	if s.snapshot.Device == "auto" {
		return nil
	}
	devices, err := s.api.devices(s.handle)
	if err != nil {
		return mpvFail("device", "output devices unavailable: "+err.Error())
	}
	if !slices.ContainsFunc(devices, func(device MpvOutputDevice) bool { return device.ID == s.snapshot.Device && device.Available }) {
		return mpvFail("device", "selected output device is unavailable")
	}
	return nil
}

func (p *MpvPlayback) withSession(ctx context.Context, lifecycle, session uint64, fn func(*mpvSession) error) error {
	return p.withLifecycle(ctx, lifecycle, func(s *mpvSession) error {
		if session != s.snapshot.Session {
			return context.Canceled
		}
		return fn(s)
	})
}

func (p *MpvPlayback) withLifecycle(ctx context.Context, lifecycle uint64, fn func(*mpvSession) error) error {
	if err := p.authorized(ctx); err != nil {
		return err
	}
	s := &p.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validLocked(ctx, lifecycle, 0); err != nil {
		return err
	}
	return fn(s)
}

func (p *MpvPlayback) Snapshot(ctx context.Context, lifecycle uint64) (MpvSnapshot, error) {
	var snapshot MpvSnapshot
	err := p.withLifecycle(ctx, lifecycle, func(s *mpvSession) error { snapshot = s.snapshot; return nil })
	return snapshot, err
}

func (p *MpvPlayback) Destroy(ctx context.Context, lifecycle uint64) error {
	return p.withLifecycle(ctx, lifecycle, func(s *mpvSession) error { s.destroyLocked(); return nil })
}

func (s *mpvSession) destroyLocked() {
	if s.pendingCancel != nil {
		s.pendingCancel()
		s.pendingCancel = nil
	}
	if s.queue != nil {
		s.queue.cancel()
		s.queue = nil
	}
	s.emit = nil
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.stopOwner != nil {
		s.stopOwner()
		s.stopOwner = nil
	}
	if s.handle != 0 {
		s.api.terminateDestroy(s.handle)
		s.handle = 0
	}
	if s.resource != nil {
		s.resource.close()
		s.resource = nil
	}
	s.owner, s.api, s.loaded, s.intent = nil, nil, false, false
	s.snapshot.Session++
	s.snapshot.State, s.snapshot.Source = "idle", ""
}

func (s *mpvSession) poll(ctx context.Context) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		s.mu.Lock()
		if ctx.Err() != nil || s.handle == 0 {
			s.mu.Unlock()
			return
		}
		s.drainLocked(true)
		if s.handle == 0 {
			s.mu.Unlock()
			return
		}
		if s.resource != nil && s.resource.ctx.Err() != nil {
			_ = s.stopLocked()
			s.snapshot.Session++
			s.emitLocked("emptied")
		}
		if s.loaded && s.snapshot.State != "error" {
			if err := s.deviceValidLocked(); err != nil {
				s.intent = false
				_ = s.pauseLocked(true)
				s.failLocked(err)
			}
			if s.handle == 0 {
				s.mu.Unlock()
				return
			}
			if value, err := s.api.number(s.handle, "time-pos"); err == nil {
				s.snapshot.Position = value
			}
			if value, err := s.api.number(s.handle, "duration"); err == nil {
				s.snapshot.Duration = value
			}
			if s.snapshot.State != "error" && s.snapshot.State != "ended" {
				s.syncPlaybackStateLocked()
				s.emitLocked("timeupdate")
			}
		}
		s.mu.Unlock()
	}
}

func (s *mpvSession) syncPlaybackStateLocked() {
	paused, pauseErr := s.api.flag(s.handle, "pause")
	buffering, cacheErr := s.api.flag(s.handle, "paused-for-cache")
	if pauseErr != nil || cacheErr != nil {
		return
	}
	s.snapshot.State = MpvStatePlaying
	if paused {
		s.snapshot.State = MpvStatePaused
	} else if buffering {
		s.snapshot.State = MpvStateBuffering
	}
	// 恢复播放不一定触发 playback-restart，由实际状态补齐播放确认。
	if s.awaitingPlay && s.snapshot.State == MpvStatePlaying {
		s.emitLocked(MpvEventPlaying)
	}
}

func (s *mpvSession) drainLocked(deliver bool) bool {
	for range 256 {
		if s.handle == 0 {
			return true
		}
		pointer := s.api.waitEvent(s.handle, 0)
		if pointer == nil || pointer.id == 0 {
			return true
		}
		event := *pointer
		// 在下一次 WaitEvent 前消费数据；辅助函数只保存 Go 值。
		if !deliver {
			continue
		}
		switch event.id {
		case 6:
			if event.data != nil {
				s.entry = *(*int64)(event.data)
			}
		case 8:
			s.fileLoadedLocked()
		case 7:
			if event.data != nil {
				s.fileEndedLocked(*(*mpvNativeEnd)(event.data))
			}
		case 20:
			s.seeking = true
			s.emitLocked("seeking")
		case 21:
			if s.loaded {
				if s.seeking {
					s.seeking = false
					s.emitLocked("seeked")
				}
				if s.intent {
					s.emitLocked("playing")
				}
			}
		case 24:
			s.failLocked(mpvFail("engine", "libmpv event queue overflow"))
		}
	}
	return false
}

func (s *mpvSession) fileLoadedLocked() {
	if s.resource == nil || s.entry < 0 {
		return
	}
	s.loaded = true
	s.snapshot.State = "paused"
	if value, err := s.api.number(s.handle, "duration"); err == nil {
		s.snapshot.Duration = value
	}
	s.emitLocked("loadedmetadata")
	s.emitLocked("durationchange")
	s.emitLocked("loadeddata")
	s.emitLocked("canplay")
	if s.start > 0 {
		s.seeking = true
		if err := s.api.run(s.handle, "seek", strconv.FormatFloat(s.start, 'f', 6, 64), "absolute+exact"); err != nil {
			s.failLocked(err)
			return
		}
	}
	if s.intent {
		if err := s.deviceValidLocked(); err != nil {
			s.failLocked(err)
		} else if err := s.pauseLocked(false); err != nil {
			s.failLocked(err)
		}
	}
}

func (s *mpvSession) fileEndedLocked(end mpvNativeEnd) {
	if s.resource == nil || s.entry < 0 || end.entry != s.entry {
		return
	}
	s.loaded = false
	switch end.reason {
	case 0:
		s.snapshot.State = "ended"
		s.emitLocked("ended")
	case 4:
		kind := MpvFailureDecode
		if s.snapshot.Device != "auto" {
			kind = "device"
		}
		s.failLocked(mpvFail(kind, "libmpv playback failed: "+strconv.Itoa(int(end.code))))
	case 5:
		s.failLocked(mpvFail("source", "secondary resources are not allowed"))
	}
}

func (s *mpvSession) emitLocked(kind MpvEventType) {
	switch kind {
	case MpvEventPlay:
		s.awaitingPlay = true
	case MpvEventPlaying, MpvEventPause, MpvEventLoadStart, MpvEventEmptied, MpvEventEnded, MpvEventError:
		s.awaitingPlay = false
	}
	s.snapshot.Sequence++
	if s.emit != nil {
		s.emit(MpvEvent{Type: kind, Snapshot: s.snapshot})
	}
}

func (s *mpvSession) failLocked(err error) {
	s.intent = false
	if s.handle != 0 {
		if s.api.setPropertyString(s.handle, "pause", "yes") < 0 {
			// 暂停失败时销毁输出句柄，不能留下仍在发声的实例。
			s.api.terminateDestroy(s.handle)
			s.handle, s.loaded = 0, false
			if s.resource != nil {
				s.resource.close()
				s.resource = nil
			}
		}
	}
	s.snapshot.State, s.snapshot.Error = "error", mpvFailureOf(err)
	s.emitLocked("error")
}
func finiteMpv(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

// 强制独立音频容器；结合 access-references=no 与 lavf protocol_whitelist=none，
// 禁止播放列表及二级网络资源绕过网关。
func mpvDemuxer(format string) (string, error) {
	formats := map[string]string{"mp3": "mp3", "flac": "flac", "wav": "wav", "ape": "ape", "dsf": "dsf", "dff": "iff", "webm": "matroska", "matroska": "matroska", "aac": "aac", "m4a": "mov", "mp4": "mov", "ogg": "ogg", "opus": "ogg", "wma": "asf", "aiff": "aiff", "aif": "aiff", "wv": "wv", "alac": "mov"}
	if value := formats[strings.ToLower(strings.TrimPrefix(format, "."))]; value != "" {
		return value, nil
	}
	return "", mpvFail("source", "unsupported standalone audio container")
}

func prepareMpvFileMutation(ctx context.Context, files *NativeFiles, info os.FileInfo) (func(), error) {
	return mpvResources.prepareMutation(ctx, files, info, &desktopMpv.session)
}

func (p *MpvPlayback) revoke() {
	// 主线程仅撤销原子令牌；清理线程按原队列身份销毁，不能误伤重新初始化的实例。
	p.revision.Add(1)
	queue := p.active.Swap(nil)
	if queue == nil {
		return
	}
	queue.cancel()
	go p.retire(queue)
}

func (p *MpvPlayback) retire(queue *mpvEventQueue) {
	p.session.mu.Lock()
	defer p.session.mu.Unlock()
	if p.session.queue == queue {
		p.session.destroyLocked()
	}
}
