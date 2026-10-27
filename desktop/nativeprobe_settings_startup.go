//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

//go:embed settings_startup_preload.js
var settingsStartupPreloadScript string

type startupNativeSnapshot struct {
	Ready                 bool `json:"ready"`
	ShortcutConfigured    bool `json:"shortcutConfigured"`
	MediaConfigured       bool `json:"mediaConfigured"`
	ShortcutEnabled       bool `json:"shortcutEnabled"`
	ShortcutRegistrations int  `json:"shortcutRegistrations"`
	MediaEnabled          bool `json:"mediaEnabled"`
	MediaShowing          bool `json:"mediaShowing"`
	MediaListener         bool `json:"mediaListener"`
	PowerLease            bool `json:"powerLease"`
}

func startupNativeState() startupNativeSnapshot {
	var snapshot startupNativeSnapshot
	mygo.RunOnMain(func() {
		snapshot = startupNativeSnapshot{
			Ready:                 desktopLifecycle.state.ready(),
			ShortcutConfigured:    desktopShortcuts.state.owner != nil,
			MediaConfigured:       desktopSystemMedia.state.owner != nil,
			ShortcutEnabled:       desktopShortcuts.state.enabled,
			ShortcutRegistrations: len(desktopShortcuts.state.owned),
			MediaEnabled:          desktopSystemMedia.state.enabled,
			MediaShowing:          desktopSystemMedia.state.showing,
			MediaListener:         desktopSystemMedia.state.off != nil,
			PowerLease:            desktopSystemMedia.state.releasePower != nil,
		}
	})
	return snapshot
}

func (s startupNativeSnapshot) disabled() bool {
	return !s.ShortcutEnabled && s.ShortcutRegistrations == 0 && !s.MediaEnabled && !s.MediaShowing && !s.MediaListener && !s.PowerLease
}

// Startup diagnostics never install a picker or enter settings file business.
func runSettingsStartupObservation() {
	progressStart := time.Now()
	progress := newStartupProgressRecorder(func() time.Duration { return time.Since(progressStart) })
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" || !filepath.IsAbs(output) || !mygo.IsDev() {
		fmt.Println(`{"passed":false,"diagnosticCompleted":false,"failureCategory":"startup-guard"}`)
		return
	}
	if os.MkdirAll(output, 0o700) != nil {
		fmt.Println(`{"passed":false,"diagnosticCompleted":false,"failureCategory":"output-create"}`)
		return
	}
	result := map[string]any{
		"passed": false, "diagnosticCompleted": false, "initialPreparationPassed": false,
		"finalSurfaceSafe": false, "businessAttempted": false, "pickerOpens": 0,
		"pickerSaves": 0, "fakeOSPicker": false, "realOSPanelVerified": false,
		"fullReloadTested": false, "screenshotAtomic": false,
	}
	var mu sync.Mutex
	failures := []startupFailure{}
	set := func(key string, value any) { mu.Lock(); result[key] = value; mu.Unlock() }
	fail := func(stage, category string) {
		mu.Lock()
		failures = append(failures, startupFailure{Stage: stage, Category: category, Count: 1})
		result["finalSurfaceSafe"] = false
		switch stage {
		case "cleanup", "long-eval", "capture-before", "capture-after", "capture", "capture-write", "run", "deadline", "exit":
			result["diagnosticCompleted"] = false
		}
		mu.Unlock()
	}
	defer func() {
		mu.Lock()
		result["startupProgress"] = progress.Seal()
		result["failures"] = failures
		result["passed"] = false
		result["businessAttempted"] = false
		result["pickerOpens"], result["pickerSaves"] = 0, 0
		encoded, err := json.MarshalIndent(result, "", "  ")
		mu.Unlock()
		if err != nil {
			fmt.Println(`{"passed":false,"diagnosticCompleted":false,"failureCategory":"result-encode"}`)
			return
		}
		if os.WriteFile(filepath.Join(output, "result.json"), encoded, 0o600) != nil {
			fmt.Println(`{"passed":false,"diagnosticCompleted":false,"failureCategory":"result-write"}`)
			return
		}
		fmt.Println(string(encoded))
	}()
	profile, err := os.MkdirTemp("/tmp", "hemusic-settings-startup-profile-")
	if err != nil {
		fail("profile", "create-failed")
		return
	}
	defer func() { set("profileRemoved", os.RemoveAll(profile) == nil) }()
	mygo.App.SetName("HE-Music Settings Startup Observation")
	mygo.App.SetPath(mygo.PathUserData, profile)
	target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" {
		fail("proxy", "loopback-guard")
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail("proxy", "listen-failed")
		return
	}
	origin := "http://" + listener.Addr().String()
	proxy := &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := proxy.Serve(listener); err != nil && err != http.ErrServerClosed {
			fail("proxy", "serve-failed")
		}
	}()
	defer func() {
		if proxy.Close() != nil {
			fail("proxy", "close-failed")
		}
	}()
	var loadMu sync.Mutex
	loads := startupLoadSnapshot{}
	loadSnapshot := func() startupLoadSnapshot { loadMu.Lock(); defer loadMu.Unlock(); return loads }
	progress.Enter(startupProgressDeadline)
	deadline := time.AfterFunc(20*time.Second, func() {
		progress.Timeout(startupProgressDeadline)
		fail("deadline", "timeout")
		mygo.App.Quit()
	})
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		progress.Enter(startupProgressAppReady)
		defer progress.Returned(startupProgressAppReady)
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "HE-Music Settings Startup Observation", Width: 1200, Height: 850,
			URL:  "about:blank",
			Page: mygo.PageOptions{PreloadScript: strings.ReplaceAll(settingsStartupPreloadScript, "__SETTINGS_STARTUP_ORIGIN__", strconv.Quote(origin))},
		})
		desktopLifecycle.attachMainWindow(win, false)
		beforeReady := startupNativeState()
		set("nativeBeforeNavigation", beforeReady)
		if !beforeReady.disabled() {
			fail("before-ready", "system-capability-enabled")
			mygo.App.Quit()
			return
		}
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			pageURL := win.Page().URL()
			loadMu.Lock()
			switch {
			case pageURL == "about:blank":
				loads.Blank++
			case pageURL == origin+"/":
				loads.Controlled++
			default:
				loads.Other++
			}
			loadMu.Unlock()
			// The true event count must stay outside once, including reloads/foreign loads.
			if pageURL == "about:blank" {
				return
			}
			if pageURL != origin+"/" {
				fail("finish-load", "unexpected-document")
				mygo.App.Quit()
				return
			}
			progress.Enter(startupProgressControlledLoad)
			progress.Returned(startupProgressControlledLoad)
			once.Do(func() {
				go func() {
					progress.Enter(startupProgressCollector)
					defer progress.Returned(startupProgressCollector)
					defer mygo.App.Quit()
					collectionComplete := false
					pollSatisfied := false
					samples := []startupSample{}
					windowState := func() map[string]bool {
						state := map[string]bool{}
						mygo.RunOnMain(func() {
							state["visible"] = win.IsVisible()
							state["minimized"] = win.IsMinimized()
							state["focused"] = win.IsFocused()
						})
						return state
					}
					progress.Enter(startupProgressWindowAtStart)
					set("windowAtStart", windowState())
					progress.Returned(startupProgressWindowAtStart)
					defer func() {
						progress.Enter(startupProgressCleanup)
						defer progress.Returned(startupProgressCleanup)
						cleanupSample := startupSample{LoadsBefore: loadSnapshot()}
						ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
						defer cancel()
						value, err := win.Page().EvalContext(ctx, `(async()=>{const m=await import("/src/nativeprobe/settingsStartupDiagnostics.ts");m.stopStartupObservation();return m.readStartupObservation()})()`)
						cleanupSample.LoadsAfter = loadSnapshot()
						if err != nil {
							fail("cleanup", startupErrorCategory(err))
							set("diagnosticCompleted", false)
							return
						}
						observation, err := decodeStartupObservation(value)
						if err != nil || observation.Current.Active {
							fail("cleanup", "invalid-cleanup-state")
							set("diagnosticCompleted", false)
							return
						}
						cleanupSample.Observation = observation
						samples = append(samples, cleanupSample)
						set("samples", append([]startupSample(nil), samples...))
						set("cleanupObservation", observation)
						set("observationCleaned", true)
						state := startupNativeState()
						set("nativeAfterCleanup", state)
						if !state.disabled() {
							fail("cleanup-native", "system-capability-enabled")
						}
						safe, reasons := evaluateStartupSamples(samples)
						set("finalSafetyReasons", reasons)
						mu.Lock()
						result["finalSurfaceSafe"] = safe && pollSatisfied && state.disabled() && len(failures) == 0
						result["diagnosticCompleted"] = collectionComplete
						result["cleanupLoads"] = cleanupSample.LoadsAfter
						mu.Unlock()
					}()
					progress.Enter(startupProgressShellWait)
					shellDeadline := time.Now().Add(8 * time.Second)
					shellReady := false
					for time.Now().Before(shellDeadline) {
						progress.Enter(startupProgressShellNativeRead)
						state := startupNativeState()
						progress.NativeReturned(state)
						if !state.disabled() {
							fail("shell-ready", "system-capability-enabled")
							return
						}
						if state.Ready && state.ShortcutConfigured && state.MediaConfigured {
							set("nativeAfterReady", state)
							shellReady = true
							break
						}
						time.Sleep(25 * time.Millisecond)
					}
					if !shellReady {
						progress.Timeout(startupProgressShellWait)
						fail("shell-ready", "timeout")
						return
					}
					progress.Returned(startupProgressShellWait)
					read := func(stage, script string, ctx context.Context) bool {
						sample := startupSample{LoadsBefore: loadSnapshot()}
						if stage == "long-eval" {
							progress.Enter(startupProgressLongEval)
							progress.Enter(startupProgressDTO)
						}
						value, evalErr := win.Page().EvalContext(ctx, script)
						if stage == "long-eval" {
							progress.Returned(startupProgressLongEval)
						}
						sample.LoadsAfter = loadSnapshot()
						if evalErr != nil {
							fail(stage, startupErrorCategory(evalErr))
							return false
						}
						observation, decodeErr := decodeStartupObservation(value)
						if decodeErr != nil {
							fail(stage, "invalid-observation")
							return false
						}
						if stage == "long-eval" {
							progress.Returned(startupProgressDTO)
						}
						sample.Observation = observation
						samples = append(samples, sample)
						set("samples", append([]startupSample(nil), samples...))
						return true
					}
					longCtx, cancelLong := context.WithTimeout(context.Background(), 7*time.Second)
					ok := read("long-eval", `(async()=>{const m=await import("/src/nativeprobe/settingsStartupDiagnostics.ts");return await m.observeSettingsStartup()})()`, longCtx)
					cancelLong()
					if !ok {
						return
					}
					set("initialPreparationPassed", samples[0].Observation.InitialPreparationPassed)
					shortScript := `(async()=>{const m=await import("/src/nativeprobe/settingsStartupDiagnostics.ts");return m.readStartupObservation()})()`
					// The entire post-long-Eval polling window is <=1s, outside native main.
					pollCtx, cancelPoll := context.WithTimeout(context.Background(), time.Second)
					for pollCtx.Err() == nil {
						if !read("post-eval-poll", shortScript, pollCtx) {
							break
						}
						current := samples[len(samples)-1].Observation
						if startupSurfaceSafe(current) {
							pollSatisfied = true
							break
						}
						select {
						case <-pollCtx.Done():
						case <-time.After(25 * time.Millisecond):
						}
					}
					cancelPoll()
					set("postEvalStateSatisfied", pollSatisfied)
					if !pollSatisfied {
						fail("post-eval-poll", "state-not-satisfied")
					}
					shortRead := func(stage string) bool {
						ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
						defer cancel()
						return read(stage, shortScript, ctx)
					}
					set("windowBeforeCapture", windowState())
					if !shortRead("capture-before") {
						return
					}
					before := samples[len(samples)-1]
					png, captureErr := win.CapturePage()
					captureOK := captureErr == nil
					if captureErr != nil {
						fail("capture", startupErrorCategory(captureErr))
					}
					if captureOK && os.WriteFile(filepath.Join(output, "startup-observation.png"), png, 0o600) != nil {
						captureOK = false
						fail("capture-write", "write-failed")
					}
					set("screenshotWritten", captureOK)
					if !shortRead("capture-after") {
						return
					}
					set("windowAfterCapture", windowState())
					after := samples[len(samples)-1]
					set("captureRevisionChanged", before.Observation.Current.Revision != after.Observation.Current.Revision)
					set("captureDocumentChanged", before.Observation.Current.DocumentID != after.Observation.Current.DocumentID)
					set("captureLoadChanged", before.LoadsBefore != after.LoadsAfter)
					state := startupNativeState()
					set("nativeAfterCapture", state)
					if !state.disabled() {
						fail("after-capture", "system-capability-enabled")
					}
					collectionComplete = captureOK
				}()
			})
		})
		if os.Getenv("HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED") != "1" {
			fail("private-store", "verification-missing")
			mygo.App.Quit()
			return
		}
		set("privateWKStoreVerified", true)
		win.Page().LoadURL(origin + "/")
	})
	progress.Enter(startupProgressAppRun)
	runErr := mygo.App.Run()
	progress.Returned(startupProgressAppRun)
	if runErr != nil {
		fail("run", startupErrorCategory(runErr))
		set("diagnosticCompleted", false)
	}
	set("finishLoads", loadSnapshot())
	mu.Lock()
	cleanupLoads, hasCleanup := result["cleanupLoads"].(startupLoadSnapshot)
	mu.Unlock()
	if hasCleanup && cleanupLoads != loadSnapshot() {
		fail("exit", "document-load-discontinuity")
	}
}
