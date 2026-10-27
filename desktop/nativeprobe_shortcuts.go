//go:build nativeprobe && shortcutprobe && !lifecycleprobe

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

// One explicit synthetic chord, isolated data/origin, no OS key injection.
func main() {
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" || !filepath.IsAbs(output) || !mygo.IsDev() {
		log.Fatal("shortcutprobe requires opt-in, absolute output and development mode")
	}
	if err := os.MkdirAll(output, 0o700); err != nil {
		log.Fatal(err)
	}
	dataDir, err := os.MkdirTemp("", "hemusic-shortcutprobe-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dataDir)
	mygo.App.SetName("HE-Music Shortcut Probe")
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
	if err != nil || target.Hostname() != "127.0.0.1" {
		log.Fatal("shortcutprobe requires loopback development server")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	proxy := &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
	defer proxy.Close()
	go func() { _ = proxy.Serve(listener) }()
	result := map[string]any{"passed": false, "feature": "global-shortcuts", "nativeKeyPressTested": false, "callbackProgrammaticallyInvoked": false}
	var mu sync.Mutex
	set := func(key string, value any) { mu.Lock(); result[key] = value; mu.Unlock() }
	deadline := time.AfterFunc(45*time.Second, func() { set("timedOut", true); mygo.App.Quit() })
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{Title: "HE-Music Shortcut Probe", Width: 1000, Height: 740,
			Page: mygo.PageOptions{PreloadScript: `localStorage.setItem("shortcut-store", JSON.stringify({globalOpen:false}));
window.__shortcutErrors={errors:0,rejections:0};
addEventListener("error",e=>{if(e.target===window)window.__shortcutErrors.errors++});
addEventListener("unhandledrejection",()=>window.__shortcutErrors.rejections++);`}})
		desktopLifecycle.attachMainWindow(win, true)
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					stage := "shell-ready"
					defer func() { set("lastStage", stage); mygo.App.Quit() }()
					wait := func(predicate func() bool) bool {
						end := time.Now().Add(10 * time.Second)
						for time.Now().Before(end) {
							var ok bool
							mygo.RunOnMain(func() { ok = predicate() })
							if ok {
								return true
							}
							time.Sleep(50 * time.Millisecond)
						}
						return false
					}
					eval := func(script string) bool {
						value, err := win.Page().Eval(script)
						if err != nil {
							set("evalFailed", true)
							set("evalErrorType", fmt.Sprintf("%T", err))
						}
						return err == nil && value == true
					}
					owned := func() bool {
						return len(desktopShortcuts.state.owned) == 1 && mygo.GlobalShortcut.IsRegistered("Ctrl+Alt+Shift+F19")
					}
					empty := func() bool {
						return len(desktopShortcuts.state.owned) == 0 && !mygo.GlobalShortcut.IsRegistered("Ctrl+Alt+Shift+F19")
					}
					if !wait(func() bool { return desktopLifecycle.state.ready() && desktopShortcuts.state.owner != nil }) {
						return
					}
					if !wait(empty) {
						return
					}
					set("defaultDisabledFixture", true)
					stage = "register-explicit-fixture"
					if !eval(`(async()=>{window.__shortcutProbe=await (await import("/src/nativeprobe/shortcuts.ts")).prepareShortcutProbe();return window.__shortcutProbe.registered()})()`) {
						set("registrationAccepted", false)
						return
					}
					if !wait(owned) {
						set("registrationAccepted", false)
						return
					}
					set("registrationAccepted", true)
					set("providerAndOwnerRegistered", true)
					stage = "recording-suspend"
					if !eval(`window.__shortcutProbe.suspend()`) || !wait(empty) {
						return
					}
					set("recordingUnregistered", true)
					stage = "recording-resume"
					if !eval(`window.__shortcutProbe.resume()`) || !wait(owned) {
						return
					}
					set("recordingRestored", true)
					stage = "hidden-typed-callback"
					mygo.RunOnMain(func() {
						win.Hide()
						_ = desktopShortcutAction.EmitPage(win.Page(), ShortcutEvent{Generation: desktopShortcuts.state.generation, Action: ShortcutVolumeUp})
					})
					if !eval(`(async()=>{for(let i=0;i<30 && window.__shortcutProbe.callbacks()!==1;i++)await new Promise(r=>setTimeout(r,30));return window.__shortcutProbe.callbacks()===1})()`) {
						return
					}
					set("callbackProgrammaticallyInvoked", true)
					stage = "disable"
					if !eval(`window.__shortcutProbe.disable()`) || !wait(empty) {
						return
					}
					set("disabledUnregistered", true)
					mygo.RunOnMain(func() {
						_ = desktopShortcutAction.EmitPage(win.Page(), ShortcutEvent{Generation: desktopShortcuts.state.generation, Action: ShortcutVolumeUp})
					})
					if !eval(`(async()=>{await new Promise(r=>setTimeout(r,60));return window.__shortcutProbe.callbacks()===1})()`) {
						return
					}
					set("disabledCallbackIgnored", true)
					stage = "cleanup"
					if !eval(`(async()=>{await window.__shortcutProbe.cleanup();return window.__shortcutErrors.errors===0 && window.__shortcutErrors.rejections===0})()`) || !wait(empty) {
						return
					}
					set("runtimeClean", true)
					set("checksComplete", true)
				}()
			})
		})
		win.Page().LoadURL("http://" + listener.Addr().String() + "/")
	})
	if err := mygo.App.Run(); err != nil {
		set("runFailed", true)
	}
	set("nativeResourcesCleaned", desktopShortcuts.state.owner == nil && len(desktopShortcuts.state.owned) == 0 && desktopLifecycle.state.cleaned)
	mu.Lock()
	result["passed"] = result["checksComplete"] == true && result["nativeResourcesCleaned"] == true && result["timedOut"] != true && result["runFailed"] != true
	encoded, err := json.MarshalIndent(result, "", "  ")
	mu.Unlock()
	if err != nil {
		log.Fatal("shortcut result encoding failed")
	}
	if err = os.WriteFile(filepath.Join(output, "result.json"), encoded, 0o600); err != nil {
		log.Fatal("shortcut result write failed")
	}
	fmt.Println(string(encoded))
}
