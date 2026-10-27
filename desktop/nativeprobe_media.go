//go:build nativeprobe

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// Development imports resolve the same Vite modules already used by the product.
// The packaged app has no such entry: do not turn a skipped matrix into a pass.
func runMediaNativeProbe(win *mygo.Window, output string) map[string]any {
	result := map[string]any{"passed": false, "syntheticOnly": true, "audibleOutputVerified": false, "userGestureVerified": false, "realBackendSongVerified": false}
	if !mygo.IsDev() {
		result["developmentOnlySkipped"] = true
		result["reason"] = "Vite module entry is intentionally excluded from production; packaged media not exercised"
		return result
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		result["stage"] = "media-listener"
		return result
	}
	// Sixteen seconds of PCM silence: actual decodable network audio, no audible noise.
	pcm := make([]byte, 44+16*8000*2)
	copy(pcm[0:], "RIFF")
	binary.LittleEndian.PutUint32(pcm[4:], uint32(len(pcm)-8))
	copy(pcm[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(pcm[16:], 16)
	binary.LittleEndian.PutUint16(pcm[20:], 1)
	binary.LittleEndian.PutUint16(pcm[22:], 1)
	binary.LittleEndian.PutUint32(pcm[24:], 8000)
	binary.LittleEndian.PutUint32(pcm[28:], 16000)
	binary.LittleEndian.PutUint16(pcm[32:], 2)
	binary.LittleEndian.PutUint16(pcm[34:], 16)
	copy(pcm[36:], "data")
	binary.LittleEndian.PutUint32(pcm[40:], uint32(len(pcm)-44))
	var requests atomic.Int32
	var ranges atomic.Int32
	server := &http.Server{ReadHeaderTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/a.wav" && r.URL.Path != "/b.wav" {
			http.NotFound(w, r)
			return
		}
		requests.Add(1)
		if r.Header.Get("Range") != "" {
			ranges.Add(1)
		}
		w.Header().Set("Content-Type", "audio/wav")
		http.ServeContent(w, r, "fixture.wav", time.Time{}, bytes.NewReader(pcm))
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	base, _ := json.Marshal("http://" + listener.Addr().String())
	eval := func(script string) (any, bool) {
		value, err := win.Page().Eval(script)
		return value, err == nil
	}
	captureBefore := func(name string) bool {
		png, err := win.CapturePage()
		return err == nil && len(png) > 0 && os.WriteFile(filepath.Join(output, name), png, 0o600) == nil
	}
	defer func() {
		value, ok := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return await m.cleanup(); })()`)
		result["cleanup"] = value
		result["cleanupEvalOK"] = ok
		result["passed"] = result["passed"] == true && ok && value == true
		isolation, isolationOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.probeIsolationDiagnostics(); })()`)
		result["postCleanupIsolation"] = isolation
		result["postCleanupIsolationEvalOK"] = isolationOK
		isolationCheck, _ := isolation.(map[string]any)
		result["passed"] = result["passed"] == true && isolationOK && isolationCheck["active"] == false
		runtime, runtimeOK := eval(`({errors: window.__m2Probe.errors, rejections: window.__m2Probe.rejections, resourceErrors: window.__m2Probe.resourceErrors, errorDiagnostics: window.__m2Probe.errorDiagnostics})`)
		result["postCleanupRuntime"] = runtime
		result["postCleanupRuntimeEvalOK"] = runtimeOK
		runtimeCheck, _ := runtime.(map[string]any)
		result["passed"] = result["passed"] == true && runtimeOK && runtimeCheck["errors"] == float64(0) && runtimeCheck["rejections"] == float64(0) && runtimeCheck["resourceErrors"] == float64(0)
	}()
	value, ok := eval(fmt.Sprintf(`(async () => { window.__m2Probe.stage = 'media-import'; const m = await import('/src/nativeprobe/media.ts'); window.__m2Probe.stage = 'media-audio'; return await m.prepareAndCheckAudio(%s); })()`, base))
	result["audio"] = value
	if !ok {
		result["stage"] = "audio-eval"
		return result
	}
	audio, _ := value.(map[string]any)
	passed := audio["passed"] == true
	for _, effect := range []string{"default", "amll", "monet"} {
		encoded, _ := json.Marshal(effect)
		pureBeforeSaved := captureBefore("media-" + effect + "-pure-before.png")
		result[effect+"PureBeforeScreenshotSaved"] = pureBeforeSaved
		pureSurface, pureSurfaceOK := eval(fmt.Sprintf(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.prepareProbeSurface(%s + '-pure'); })()`, encoded))
		result[effect+"PureSurface"] = pureSurface
		result[effect+"PureSurfaceEvalOK"] = pureSurfaceOK
		pureSurfaceCheck, _ := pureSurface.(map[string]any)
		passed = passed && pureBeforeSaved && pureSurfaceOK && pureSurfaceCheck["passed"] == true
		value, ok = eval(fmt.Sprintf(`(async () => { const effect = %s; window.__m2Probe.stage = 'media-' + effect; const m = await import('/src/nativeprobe/media.ts'); return await m.checkEffect(effect); })()`, encoded))
		result[effect] = value
		checks, _ := value.(map[string]any)
		png, captureErr := win.CapturePage()
		if captureErr == nil {
			captureErr = os.WriteFile(filepath.Join(output, "media-"+effect+".png"), png, 0o600)
		}
		captured := captureErr == nil && len(png) > 0
		result[effect+"ScreenshotSaved"] = captured
		passed = passed && ok && checks["passed"] == true && captured
		start, startOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.startVisibility(); })()`)
		result[effect+"VisibilityStart"] = start
		result[effect+"VisibilityStartEvalOK"] = startOK
		passed = passed && startOK && start == true
		win.Hide()
		hidden, hiddenOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.hiddenFrames(); })()`)
		result[effect+"Hidden"] = hidden
		result[effect+"HiddenEvalOK"] = hiddenOK
		hiddenCheck, _ := hidden.(map[string]any)
		visibilityValidated := hiddenOK && hiddenCheck["visibility"] == "hidden"
		result[effect+"VisibilityValidated"] = visibilityValidated
		passed = passed && visibilityValidated && hiddenCheck["clock"] == float64(0) && hiddenCheck[effect] == float64(0)
		win.Show()
		stop, stopOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.stopVisibility(); })()`)
		result[effect+"VisibilityStop"] = stop
		result[effect+"VisibilityStopEvalOK"] = stopOK
		stopCheck, _ := stop.(map[string]any)
		passed = passed && stopOK && stopCheck["paused"] == true && stopCheck["visibility"] == "visible"
		halfBeforeSaved := captureBefore("media-" + effect + "-half-before.png")
		result[effect+"HalfBeforeScreenshotSaved"] = halfBeforeSaved
		halfSurface, halfSurfaceOK := eval(fmt.Sprintf(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.prepareProbeSurface(%s + '-half'); })()`, encoded))
		result[effect+"HalfSurface"] = halfSurface
		result[effect+"HalfSurfaceEvalOK"] = halfSurfaceOK
		halfSurfaceCheck, _ := halfSurface.(map[string]any)
		passed = passed && halfBeforeSaved && halfSurfaceOK && halfSurfaceCheck["passed"] == true
		half, halfOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.halfLayout(); })()`)
		halfPNG, halfErr := win.CapturePage()
		if halfErr == nil {
			halfErr = os.WriteFile(filepath.Join(output, "media-"+effect+"-half.png"), halfPNG, 0o600)
		}
		result[effect+"HalfLayout"] = halfOK && half == true
		result[effect+"HalfScreenshotSaved"] = halfErr == nil && len(halfPNG) > 0
		passed = passed && halfOK && half == true && halfErr == nil && len(halfPNG) > 0
	}
	result["mediaRequests"] = requests.Load()
	result["rangeRequests"] = ranges.Load()
	isolation, isolationOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.probeIsolationDiagnostics(); })()`)
	result["isolation"] = isolation
	result["isolationEvalOK"] = isolationOK
	passed = passed && isolationOK
	diagnostics, diagnosticsOK := eval(`(async () => { const m = await import('/src/nativeprobe/media.ts'); return m.diagnostics(); })()`)
	result["errorDiagnostics"] = diagnostics
	result["errorDiagnosticsEvalOK"] = diagnosticsOK
	runtime, runtimeOK := eval(`({errors: window.__m2Probe.errors, rejections: window.__m2Probe.rejections, resourceErrors: window.__m2Probe.resourceErrors, errorDiagnostics: window.__m2Probe.errorDiagnostics})`)
	result["runtime"] = runtime
	result["runtimeEvalOK"] = runtimeOK
	runtimeCheck, _ := runtime.(map[string]any)
	passed = passed && runtimeOK && runtimeCheck["errors"] == float64(0) && runtimeCheck["rejections"] == float64(0) && runtimeCheck["resourceErrors"] == float64(0)
	result["passed"] = passed && requests.Load() > 0
	return result
}
