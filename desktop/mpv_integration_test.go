package main

import (
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 显式提供准备好的真实库才执行；合成样本与 ao=null 不访问真实设备或用户音源。
func mpvIntegrationLibrary(t *testing.T) *mpvAPI {
	t.Helper()
	libraryPath := os.Getenv("MPV_INTEGRATION_LIBRARY")
	if libraryPath == "" {
		t.Skip("未指定 MPV_INTEGRATION_LIBRARY，跳过真实 libmpv 隔离测试")
	}
	library := new(mpvLibrary)
	api, err := library.load(libraryPath)
	if err != nil {
		t.Fatal(err)
	}
	session := new(mpvSession)
	session.mu.Lock()
	if err := session.initializeLocked(t.Context(), api, "null"); err != nil {
		session.mu.Unlock()
		t.Fatalf("真实库不接受生产初始化选项: %v", err)
	}
	session.destroyLocked()
	session.mu.Unlock()
	return api
}

func TestMpvBundledLibraryNullAudio(t *testing.T) {
	api := mpvIntegrationLibrary(t)
	handle := api.create()
	if handle == 0 {
		t.Fatal("真实 libmpv 创建失败")
	}
	t.Cleanup(func() { api.terminateDestroy(handle) })
	// 缩短 null 后端默认的 200ms 模拟缓冲，使暂停 seek 的时钟误差低于验收容差。
	for key, value := range map[string]string{
		"config": "no", "load-scripts": "no", "video": "no", "audio-display": "no",
		"terminal": "no", "ao": "null", "ao-null-buffer": "0.05", "idle": "yes", "keep-open": "yes", "pause": "yes",
	} {
		if err := mpvResult(key, api.setOptionString(handle, key, value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := mpvResult("initialize", api.initialize(handle)); err != nil {
		t.Fatal(err)
	}
	const sampleRate = 48000
	const pcmSize = sampleRate * 6 * 4
	wave := make([]byte, 44+pcmSize)
	copy(wave, "RIFF")
	binary.LittleEndian.PutUint32(wave[4:], 36+pcmSize)
	copy(wave[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wave[16:], 16)
	binary.LittleEndian.PutUint16(wave[20:], 1)
	binary.LittleEndian.PutUint16(wave[22:], 2)
	binary.LittleEndian.PutUint32(wave[24:], sampleRate)
	binary.LittleEndian.PutUint32(wave[28:], sampleRate*4)
	binary.LittleEndian.PutUint16(wave[32:], 4)
	binary.LittleEndian.PutUint16(wave[34:], 16)
	copy(wave[36:], "data")
	binary.LittleEndian.PutUint32(wave[40:], pcmSize)
	for index := range sampleRate * 6 {
		value := uint16(int16(math.Sin(float64(index)*2*math.Pi*440/sampleRate) * 1000))
		binary.LittleEndian.PutUint16(wave[44+index*4:], value)
		binary.LittleEndian.PutUint16(wave[46+index*4:], value)
	}
	sample := filepath.Join(t.TempDir(), "合成 sample.wav")
	if err := os.WriteFile(sample, wave, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := api.run(handle, "loadfile", sample); err != nil {
		t.Fatal(err)
	}
	wait := func(label string, condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if condition() {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		position, positionErr := api.number(handle, "time-pos")
		duration, durationErr := api.number(handle, "duration")
		t.Logf("超时快照 position=%f (%v), duration=%f (%v)", position, positionErr, duration, durationErr)
		t.Fatalf("等待 %s 超时", label)
	}
	wait("合成音频载入", func() bool {
		duration, err := api.number(handle, "duration")
		return err == nil && duration > 5.5
	})
	setPause := func(value string) {
		t.Helper()
		if err := mpvResult("pause", api.setPropertyString(handle, "pause", value)); err != nil {
			t.Fatal(err)
		}
	}
	setPause("no")
	wait("真实播放时钟前进", func() bool {
		position, err := api.number(handle, "time-pos")
		return err == nil && position > 0.3
	})
	setPause("yes")
	time.Sleep(100 * time.Millisecond)
	paused, err := api.number(handle, "time-pos")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	position, err := api.number(handle, "time-pos")
	if err != nil || math.Abs(position-paused) > 0.08 {
		t.Fatalf("暂停时钟不稳定: %f -> %f, %v", paused, position, err)
	}
	if err := api.run(handle, "seek", "3", "absolute+exact"); err != nil {
		t.Fatal(err)
	}
	wait("真实 seek", func() bool {
		position, err := api.number(handle, "time-pos")
		return err == nil && math.Abs(position-3) < 0.15
	})
	setPause("no")
	wait("seek 后恢复时钟", func() bool {
		position, err := api.number(handle, "time-pos")
		return err == nil && position > 3.3
	})
	if err := api.run(handle, "stop"); err != nil {
		t.Fatal(err)
	}
	t.Log("真实 libmpv API 2.6 加载/合成 WAV 时钟/暂停/seek/stop 通过；清理时销毁；ao=null 不代表可闻发声")
}

// 与生产相同的 initializeLocked / Load / mpvResource / NetworkGateway 链路。
func TestMpvBundledProductionGatewayContainers(t *testing.T) {
	api := mpvIntegrationLibrary(t)
	directory := t.TempDir()
	python, err := exec.LookPath("python3")
	if err != nil {
		python, err = exec.LookPath("python")
	}
	requireTestNoError(t, err)
	generate := exec.CommandContext(t.Context(), python, "-c", "import runpy,sys; from pathlib import Path; runpy.run_path('../scripts/mpv/audio_fixtures.py')['samples'](Path(sys.argv[1]))", directory)
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("生成隔离样本: %v\n%s", err, output)
	}
	webm := filepath.Join(directory, "合成.webm")
	generate = exec.CommandContext(t.Context(), "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", "-c:a", "libopus", webm)
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("生成 WebM 音频: %v\n%s", err, output)
	}
	upstream := httptest.NewServer(http.FileServer(http.Dir(directory)))
	t.Cleanup(upstream.Close)
	prefix, err := newDirectoryToken()
	requireTestNoError(t, err)
	gateway := &NetworkGateway{prefix: "/" + prefix, media: newDesktopGatewayClient()}
	server := httptest.NewUnstartedServer(http.HandlerFunc(gateway.serveHTTP))
	gateway.host = server.Listener.Addr().String()
	server.Start()
	t.Cleanup(server.Close)
	p := &MpvPlayback{checkOwner: func(ctx context.Context) error { return ctx.Err() }}
	p.createResource = func(ctx, owner context.Context, request MpvLoadRequest) (*mpvResource, error) {
		return mpvResources.create(ctx, owner, nil, gateway, request)
	}
	s := &p.session
	s.mu.Lock()
	err = s.initializeLocked(t.Context(), api, "null")
	lifecycle := s.snapshot.Lifecycle
	s.mu.Unlock()
	requireTestNoError(t, err)
	t.Cleanup(func() { s.mu.Lock(); s.destroyLocked(); s.mu.Unlock() })
	for _, name := range []string{"合成 sample.wav", "合成.dsf", "合成.dff", "合成.webm"} {
		t.Run(filepath.Ext(name), func(t *testing.T) {
			// owner context 与初始化一致；子测试的 context 不能冒充会话 owner。
			ctx := s.owner
			loaded, err := p.Load(ctx, lifecycle, MpvLoadRequest{
				URL:    server.URL + gateway.prefix + "/__proxy/" + upstream.URL + "/" + url.PathEscape(name),
				Format: strings.TrimPrefix(filepath.Ext(name), "."),
			})
			requireTestNoError(t, err)
			wait := func(label string, predicate func(MpvSnapshot) bool) {
				t.Helper()
				deadline := time.Now().Add(8 * time.Second)
				for time.Now().Before(deadline) {
					snapshot, err := p.Snapshot(ctx, lifecycle)
					requireTestNoError(t, err)
					if snapshot.Error != nil {
						t.Fatalf("%s: %+v", label, snapshot)
					}
					if predicate(snapshot) {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("等待 %s 超时", label)
			}
			wait("暂停载入", func(value MpvSnapshot) bool { return value.State == "paused" && value.Duration > 5.5 })
			requireTestNoError(t, p.Play(ctx, lifecycle, loaded.Session))
			wait("生产播放时钟", func(value MpvSnapshot) bool { return value.Position > 0.3 })
			requireTestNoError(t, p.Pause(ctx, lifecycle, loaded.Session))
			requireTestNoError(t, p.Seek(ctx, lifecycle, loaded.Session, 3))
			wait("生产 seek", func(value MpvSnapshot) bool { return math.Abs(value.Position-3) < 0.3 })
			_, err = p.ClearSource(ctx, lifecycle, loaded.Session)
			requireTestNoError(t, err)
			t.Log("生产初始化/Load/受控网关/解码/播放/暂停/seek/释放通过；ao=null，不代表可闻发声")
		})
	}
}
