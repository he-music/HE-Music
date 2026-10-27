//go:build nativeprobe && lifecycleprobe

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// This separate opt-in executable exercises lifecycle only, never the media matrix.
func main() {
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" || !filepath.IsAbs(output) || !mygo.IsDev() {
		log.Fatal("lifecycleprobe requires opt-in, absolute output directory and development mode")
	}
	if err := os.MkdirAll(output, 0o700); err != nil {
		log.Fatal(err)
	}
	dataDir, err := os.MkdirTemp("", "hemusic-lifecycleprobe-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dataDir)
	mygo.App.SetName("HE-Music Lifecycle Probe")
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
	if err != nil || target.Hostname() != "127.0.0.1" {
		log.Fatal("lifecycleprobe requires loopback development server")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	proxy := &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
	defer proxy.Close()
	go func() { _ = proxy.Serve(listener) }()
	pageURL := "http://" + listener.Addr().String() + "/"

	result := map[string]any{"passed": false, "feature": "desktop-lifecycle", "nativeMenuMouseClickTested": false, "dockMouseClickTested": false}
	var mu sync.Mutex
	set := func(key string, value any) { mu.Lock(); result[key] = value; mu.Unlock() }
	deadline := time.AfterFunc(45*time.Second, func() { set("timedOut", true); mygo.App.Quit() })
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "HE-Music Lifecycle Probe", Width: 1100, Height: 780,
			Page: mygo.PageOptions{PreloadScript: `window.__lifecycleErrors = { errors: 0, rejections: 0 };
addEventListener("error", event => { if (event.target === window) window.__lifecycleErrors.errors++; });
addEventListener("unhandledrejection", () => window.__lifecycleErrors.rejections++);`},
		})
		desktopLifecycle.attachMainWindow(win, true)
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					stage := "shell-ready"
					completed := false
					defer func() {
						if !completed {
							set("failedStage", stage)
							diagnostic, diagnosticErr := win.Page().Eval(`({ errors: window.__lifecycleErrors?.errors, rejections: window.__lifecycleErrors?.rejections })`)
							set("runtimeDiagnostics", diagnostic)
							set("diagnosticEvalOK", diagnosticErr == nil)
							mygo.App.Quit()
						}
					}()
					wait := func(predicate func() bool) bool {
						until := time.Now().Add(8 * time.Second)
						for time.Now().Before(until) {
							var ok bool
							mygo.RunOnMain(func() { ok = predicate() })
							if ok {
								return true
							}
							time.Sleep(50 * time.Millisecond)
						}
						return false
					}
					evalTrue := func(script string) bool {
						value, err := win.Page().Eval(script)
						if err != nil {
							set("evalFailed", true)
							set("evalErrorType", fmt.Sprintf("%T", err))
							return false
						}
						return err == nil && value == true
					}
					if !wait(func() bool { return desktopLifecycle.state.ready() && desktopLifecycle.tray != nil }) {
						return
					}
					stage = "tray-installation"
					var installed bool
					mygo.RunOnMain(func() {
						bounds := desktopLifecycle.tray.Bounds()
						installed = bounds.Width > 0 && bounds.Height > 0 && desktopLifecycle.menu != nil
					})
					set("trayBoundsPositive", installed)
					if !installed {
						return
					}
					stage = "frontend-prepare"
					if !evalTrue(`(async () => { const module = await import("/src/nativeprobe/lifecycle.ts"); window.__lifecycleProbe = await module.prepareLifecycleProbe(); return window.__lifecycleProbe.installed(); })()`) {
						return
					}
					if !wait(func() bool { return desktopLifecycle.playback.HasSong && desktopLifecycle.state.config.ShowCloseAppTip }) {
						return
					}
					stage = "default-close-prompt"
					win.Close()
					if !wait(func() bool {
						return desktopLifecycle.state.pending != 0 && desktopLifecycle.state.acknowledged && win.IsVisible()
					}) {
						return
					}
					if !evalTrue(`window.__lifecycleProbe.promptVisible()`) {
						return
					}
					set("nativeClosePromptAcknowledged", true)
					stage = "cancel-close"
					if !evalTrue(`(() => { window.__lifecycleProbe.cancel(); return true; })()`) {
						return
					}
					if !wait(func() bool { return desktopLifecycle.state.pending == 0 && win.IsVisible() }) {
						return
					}
					set("cancelKeepsWindow", true)
					stage = "menu-player-contract"
					mygo.RunOnMain(func() {
						for _, index := range []int{2, 3, 4} {
							items := desktopLifecycle.menu.Items()
							if len(items) == 7 && !items[index].Disabled && items[index].Click != nil {
								items[index].Click(items[index], nil)
							}
						}
					})
					if !evalTrue(`(async () => { const end = Date.now()+4000; while (window.__lifecycleProbe.calls().length < 3 && Date.now()<end) await new Promise(resolve => setTimeout(resolve, 50)); return JSON.stringify(window.__lifecycleProbe.calls()) === JSON.stringify(["prev","toggle","next"]); })()`) {
						return
					}
					set("menuCallbackPlayerExactlyOnce", true)
					stage = "remember-hide"
					win.Close()
					if !wait(func() bool { return desktopLifecycle.state.pending != 0 && desktopLifecycle.state.acknowledged }) {
						return
					}
					if !evalTrue(`(() => { window.__lifecycleProbe.choose("hide", true); return true; })()`) {
						return
					}
					if !wait(func() bool {
						return !win.IsVisible() && !desktopLifecycle.state.config.ShowCloseAppTip && desktopLifecycle.state.config.CloseAppMethod == CloseAppHide
					}) {
						return
					}
					if !evalTrue(`window.__lifecycleProbe.remembered()`) {
						return
					}
					set("rememberHideApplied", true)
					stage = "tray-show-callback"
					mygo.RunOnMain(func() { items := desktopLifecycle.menu.Items(); items[0].Click(items[0], nil) })
					if !wait(win.IsVisible) {
						return
					}
					set("trayShowRestoresWindow", true)
					stage = "remembered-native-close"
					win.Close()
					if !wait(func() bool { return !win.IsVisible() && desktopLifecycle.state.pending == 0 }) {
						return
					}
					set("rememberedCloseHidesWithoutPrompt", true)
					stage = "teardown-hidden-fallback"
					if !evalTrue(`window.__lifecycleProbe.teardown()`) {
						return
					}
					if !wait(func() bool {
						return win.IsVisible() && !desktopLifecycle.state.ready() && desktopLifecycle.state.closeDecision() == closeAllow
					}) {
						return
					}
					set("teardownRestoresAndAllowsClose", true)
					stage = "teardown-disables-menu"
					mygo.RunOnMain(func() { items := desktopLifecycle.menu.Items(); items[3].Click(items[3], nil) })
					if !evalTrue(`(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return window.__lifecycleProbe.calls().length === 3; })()`) {
						return
					}
					set("teardownStopsActions", true)
					stage = "cleanup-runtime"
					if !evalTrue(`(async () => { await window.__lifecycleProbe.cleanup(); return window.__lifecycleErrors.errors === 0 && window.__lifecycleErrors.rejections === 0; })()`) {
						return
					}
					set("runtimeClean", true)
					completed = true
					set("checksComplete", true)
					// The actual installed menu callback performs explicit Quit with no ready owner.
					mygo.RunOnMain(func() { items := desktopLifecycle.menu.Items(); items[6].Click(items[6], nil) })
				}()
			})
		})
		win.Page().LoadURL(pageURL)
	})
	if err := mygo.App.Run(); err != nil {
		set("runFailed", true)
	}
	set("nativeResourcesCleaned", desktopLifecycle.state.cleaned && desktopLifecycle.tray == nil && desktopLifecycle.menu == nil && desktopLifecycle.main == nil && len(desktopLifecycle.listeners) == 0 && desktopLifecycle.promptTimer == nil && desktopLifecycle.stopOwner == nil)
	mu.Lock()
	result["passed"] = result["checksComplete"] == true && result["nativeResourcesCleaned"] == true && result["timedOut"] != true && result["runFailed"] != true
	encoded, err := json.MarshalIndent(result, "", "  ")
	mu.Unlock()
	if err != nil {
		log.Fatal("lifecycle result encoding failed")
	}
	if err := os.WriteFile(filepath.Join(output, "result.json"), encoded, 0o600); err != nil {
		log.Fatal("lifecycle result write failed")
	}
	fmt.Println(string(encoded))
}
