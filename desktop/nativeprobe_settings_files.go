//go:build nativeprobe && fileprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe

package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// The only fake is the OS picker; all policy, bridge and file IO remain real.
type settingsProbePicker struct {
	mu           sync.Mutex
	root         string
	saves, opens int
	gate         chan struct{}
}

func (p *settingsProbePicker) Save(mygo.SaveDialogOptions) (string, error) {
	p.mu.Lock()
	p.saves++
	gate := p.gate
	p.mu.Unlock()
	<-gate
	return filepath.Join(p.root, "export.json"), nil
}
func (p *settingsProbePicker) Open(options mygo.OpenDialogOptions) ([]string, error) {
	p.mu.Lock()
	p.opens++
	n := p.opens
	p.mu.Unlock()
	if options.Directory {
		return nil, fmt.Errorf("directory smoke not enabled")
	}
	switch n {
	case 1:
		return nil, nil
	case 2:
		return []string{filepath.Join(p.root, "bad.json")}, nil
	case 3:
		return []string{filepath.Join(p.root, "legacy.json")}, nil
	}
	return nil, fmt.Errorf("unexpected probe picker invocation")
}
func (p *settingsProbePicker) counts() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.saves, p.opens
}

func main() {
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := os.Unsetenv("HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED"); err != nil {
		log.Fatal("fileprobe cannot reset private store marker")
	}
	if os.Getenv("HE_MUSIC_FILE_PROBE_STARTUP_ONLY") != "" {
		if os.Getenv("HE_MUSIC_FILE_PROBE_STARTUP_ONLY") != "1" {
			log.Fatal("invalid startup-only mode")
		}
		runSettingsStartupObservation()
		return
	}
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" || !filepath.IsAbs(output) || !mygo.IsDev() {
		log.Fatal("fileprobe requires opt-in absolute output and development")
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		log.Fatal(err)
	}
	profile, err := os.MkdirTemp("/tmp", "hemusic-settings-native-profile-")
	if err != nil {
		log.Fatal(err)
	}
	fixture, err := os.MkdirTemp("/tmp", "hemusic-settings-native-fixture-")
	if err != nil {
		log.Fatal(err)
	}
	mygo.App.SetName("HE-Music Settings File Probe")
	mygo.App.SetPath(mygo.PathUserData, profile)
	for _, name := range []string{"Music", "Downloads"} {
		if err = os.Mkdir(filepath.Join(fixture, name), 0700); err != nil {
			log.Fatal(err)
		}
	}
	documents := map[string]string{
		"bad.json":    `{"renderer":{"setting-store":"{\"lyricsScrollOffset\":-0.5}","shortcut-store":"{\"globalOpen\":\"bad\"}"},"electron":{"syntheticNative":true}}`,
		"legacy.json": `{"renderer":{"setting-store":"{\"lyricsScrollOffset\":-0.25,\"smtcOpen\":false,\"preventSleep\":false,\"autoPlay\":false}","shortcut-store":"{\"globalOpen\":false}"},"electron":{"syntheticNative":true}}`,
	}
	for name, data := range documents {
		if err = os.WriteFile(filepath.Join(fixture, name), []byte(data), 0600); err != nil {
			log.Fatal(err)
		}
	}
	picker := &settingsProbePicker{root: fixture, gate: make(chan struct{})}
	desktopFiles.state.picker = picker
	desktopFiles.state.defaultPath = func(kind DefaultDirectoryKind) (string, error) {
		if kind == DefaultDirectoryMusic {
			return filepath.Join(fixture, "Music"), nil
		}
		return filepath.Join(fixture, "Downloads"), nil
	}
	target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
	if err != nil || target.Hostname() != "127.0.0.1" {
		log.Fatal("loopback Vite required")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	proxy := &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = proxy.Serve(listener) }()
	result := map[string]any{"passed": false, "fakeOSPicker": true, "realOSPanelVerified": false, "fullReloadTested": false, "directoryUITested": false, "profile": profile, "fixture": fixture, "proxyPort": listener.Addr().(*net.TCPAddr).Port}
	var mu sync.Mutex
	set := func(key string, value any) { mu.Lock(); result[key] = value; mu.Unlock() }
	deadline := time.AfterFunc(45*time.Second, func() { set("timedOut", true); mygo.App.Quit() })
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{URL: "about:blank", Title: "HE-Music Settings File Probe", Width: 1200, Height: 850, Page: mygo.PageOptions{PreloadScript: fmt.Sprintf(`
if (location.protocol !== "about:" && location.origin === %s) {
localStorage.setItem("shortcut-store",JSON.stringify({globalOpen:false}));
localStorage.setItem("setting-store",JSON.stringify({smtcOpen:false,preventSleep:false,autoPlay:false}));
window.__settingsFileRuntime={errors:[],rejections:0,loads:1};
addEventListener("error",e=>{if(e.target===window)window.__settingsFileRuntime.errors.push({name:e.error?.name||"ErrorEvent",anonymous:e.message==="Script error."||e.message==="Script error",resizeObserver:String(e.message).includes("ResizeObserver")})});
addEventListener("unhandledrejection",()=>window.__settingsFileRuntime.rejections++);
}
`, strconv.Quote("http://"+listener.Addr().String()))}})
		desktopLifecycle.attachMainWindow(win, false)
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			if win.Page().URL() == "about:blank" {
				return
			}
			once.Do(func() {
				go func() {
					stage := "shell-ready"
					defer func() { set("lastStage", stage); mygo.App.Quit() }()
					wait := func(predicate func() bool) bool {
						end := time.Now().Add(8 * time.Second)
						for time.Now().Before(end) {
							var ok bool
							mygo.RunOnMain(func() { ok = predicate() })
							if ok {
								return true
							}
							time.Sleep(25 * time.Millisecond)
						}
						return false
					}
					eval := func(script string) bool {
						value, e := win.Page().Eval(script)
						if e != nil {
							set("evalError", fmt.Sprintf("%v", e))
						}
						if e != nil || value != true {
							diagnostic, diagnosticErr := win.Page().Eval(`(async()=>{const isolation=await import("/src/nativeprobe/isolation.ts");return {isolation:isolation.isolationDiagnostics(),startup:(await import("/src/nativeprobe/settingsSurface.ts")).settingsStartupDiagnostics(),runtime:window.__settingsFileRuntime,surface:[...document.querySelectorAll(".n-modal-container,.n-drawer,.main-setting,vite-error-overlay")].map(node=>({classes:node.className,visible:node.getClientRects().length>0,login:!!node.querySelector(".login"),agreement:!!node.querySelector(".user-agreement"),settings:!!node.querySelector(".setting")}))}})()`)
							if diagnosticErr == nil {
								set("failureDiagnostics", diagnostic)
							} else {
								set("failureDiagnosticsError", fmt.Sprintf("%T", diagnosticErr))
							}
							pngBytes, captureErr := win.CapturePage()
							if captureErr == nil {
								set("failureScreenshotWritten", os.WriteFile(filepath.Join(output, "failure.png"), pngBytes, 0o600) == nil)
							} else {
								set("failureScreenshotError", fmt.Sprintf("%T", captureErr))
							}
						}
						return e == nil && value == true
					}
					if !wait(func() bool {
						return desktopLifecycle.state.ready() && desktopFiles.state.owner != nil && !desktopSystemMedia.state.enabled && desktopSystemMedia.state.releasePower == nil
					}) {
						return
					}
					stage = "real-lyrics-settings-menu"
					if !eval(`(async()=>{window.__settingsFileProbe=await(await import("/src/nativeprobe/settingsFiles.ts")).prepareSettingsFileProbe();return true})()`) {
						return
					}
					set("actualLyricsToGeneralUI", true)
					stage = "export-busy"
					if !eval(`window.__settingsFileProbe.startExport()`) {
						return
					}
					if !wait(func() bool { s, _ := picker.counts(); return s == 1 }) {
						return
					}
					if !eval(`window.__settingsFileProbe.disabled()`) {
						return
					}
					s, o := picker.counts()
					if s != 1 || o != 0 {
						return
					}
					set("disabledWithoutRequestStack", true)
					close(picker.gate)
					if !eval(`window.__settingsFileProbe.exported()`) {
						return
					}
					data, e := os.ReadFile(filepath.Join(fixture, "export.json"))
					if e != nil {
						return
					}
					var envelope map[string]json.RawMessage
					if json.Unmarshal(data, &envelope) != nil || len(envelope) != 3 {
						return
					}
					var renderer map[string]string
					if json.Unmarshal(envelope["renderer"], &renderer) != nil || len(renderer) != 2 || renderer["setting-store"] == "" || renderer["shortcut-store"] == "" {
						return
					}
					set("exportEnvelopeOnlyTwoRendererStores", true)
					set("exportBytes", len(data))
					set("exportSHA256", fmt.Sprintf("%x", sha256.Sum256(data)))
					stage = "cancel-silent"
					if !eval(`window.__settingsFileProbe.cancelled()`) {
						return
					}
					set("cancelSilentNoStorageWrite", true)
					stage = "bad-second-store"
					if !eval(`window.__settingsFileProbe.invalid()`) {
						return
					}
					set("invalidSecondStoreWritesNeither", true)
					stage = "valid-import-close-unmount"
					if !eval(`window.__settingsFileProbe.validAndClose()`) {
						return
					}
					set("validLegacyImportAndUnmountCancelsReload", true)
					picker.mu.Lock()
					picker.gate = make(chan struct{})
					picker.mu.Unlock()
					stage = "late-save-close"
					if !eval(`window.__settingsFileProbe.lateStart()`) {
						return
					}
					if !wait(func() bool { s, _ := picker.counts(); return s == 2 }) {
						return
					}
					if !eval(`window.__settingsFileProbe.lateClose()`) {
						return
					}
					close(picker.gate)
					if !eval(`window.__settingsFileProbe.lateFinished()`) {
						return
					}
					set("lateSavedAfterUnmountNoNotice", true)
					stage = "runtime-and-cleanup"
					value, e := win.Page().Eval(`(async()=>{const cleanup=await window.__settingsFileProbe.cleanup();return {cleanup,runtime:window.__settingsFileRuntime}})()`)
					if e != nil {
						set("cleanupEvalError", fmt.Sprintf("%v", e))
						return
					}
					set("frontendEvidence", value)
					if !eval(`window.__settingsFileRuntime.errors.length===0&&window.__settingsFileRuntime.rejections===0`) {
						return
					}
					set("runtimeClean", true)
					set("checksComplete", true)
				}()
			})
		})
		if os.Getenv("HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED") != "1" {
			set("privateStoreVerificationFailed", true)
			mygo.App.Quit()
			return
		}
		set("privateWKStoreVerified", true)
		win.Page().LoadURL("http://" + listener.Addr().String() + "/")
	})
	if err = mygo.App.Run(); err != nil {
		set("runError", fmt.Sprintf("%T", err))
	}
	_ = proxy.Close()
	set("nativeResourcesCleaned", desktopFiles.state.owner == nil && desktopFiles.state.busy == nil && len(desktopFiles.state.grants) == 0 && desktopLifecycle.state.cleaned && desktopSystemMedia.state.releasePower == nil)
	s, o := picker.counts()
	set("pickerSaves", s)
	set("pickerOpens", o)
	set("profileRemoved", os.RemoveAll(profile) == nil)
	set("fixtureRemoved", os.RemoveAll(fixture) == nil)
	mu.Lock()
	result["passed"] = result["checksComplete"] == true && result["runtimeClean"] == true && result["nativeResourcesCleaned"] == true && result["profileRemoved"] == true && result["fixtureRemoved"] == true && result["timedOut"] != true && result["runError"] == nil
	encoded, _ := json.MarshalIndent(result, "", "  ")
	mu.Unlock()
	if err = os.WriteFile(filepath.Join(output, "result.json"), encoded, 0600); err != nil {
		log.Fatal(err)
	}
	fmt.Println(string(encoded))
}
