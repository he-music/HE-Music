//go:build nativeprobe && mediaprobe && !lifecycleprobe && !shortcutprobe

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
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Observers forward to the real APIs, and record only synthetic-fixture lifecycle counts.
// Neither these counts nor module state establish OS panel or display sleep effects.
type probeSystemMedia struct {
	backend                                          systemMediaBackend
	sets, playbacks, clears, subscriptions, removals int
	callback                                         func(mygo.MediaCommand, time.Duration)
}

func (p *probeSystemMedia) Set(info mygo.NowPlayingInfo)      { p.sets++; p.backend.Set(info) }
func (p *probeSystemMedia) Info() (mygo.NowPlayingInfo, bool) { return p.backend.Info() }
func (p *probeSystemMedia) SetPlayback(state mygo.PlaybackState, position time.Duration) {
	p.playbacks++
	p.backend.SetPlayback(state, position)
}
func (p *probeSystemMedia) Clear() { p.clears++; p.backend.Clear() }
func (p *probeSystemMedia) OnCommand(callback func(mygo.MediaCommand, time.Duration)) func() {
	p.subscriptions++
	p.callback = callback
	off := p.backend.OnCommand(callback)
	return func() { p.removals++; off() }
}

type probeSystemPower struct {
	backend            systemPowerBackend
	acquires, releases int
}

func (p *probeSystemPower) KeepAwake(reason string, display bool) func() {
	p.acquires++
	release := p.backend.KeepAwake(reason, display)
	return func() { p.releases++; release() }
}

func main() {
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" || !filepath.IsAbs(output) || !mygo.IsDev() {
		log.Fatal("mediaprobe requires opt-in, absolute output and development mode")
	}
	if err := os.MkdirAll(output, 0o700); err != nil {
		log.Fatal(err)
	}
	dataDir, err := os.MkdirTemp("", "hemusic-system-mediaprobe-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dataDir)
	mygo.App.SetName("HE-Music System Media Probe")
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
	if err != nil || target.Hostname() != "127.0.0.1" {
		log.Fatal("mediaprobe requires loopback development server")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	proxy := &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
	defer proxy.Close()
	go func() { _ = proxy.Serve(listener) }()
	media := &probeSystemMedia{backend: desktopSystemMedia.state.media}
	power := &probeSystemPower{backend: desktopSystemMedia.state.power}
	desktopSystemMedia.state.media = media
	desktopSystemMedia.state.power = power
	result := map[string]any{
		"passed": false, "feature": "system-media-and-power", "artwork": "pending",
		"nativeKeyPressTested": false, "osPanelVerified": false, "displaySleepExperiment": false,
		"playerEntriesAreSyntheticFixture": true, "callbackProgrammaticallyInvoked": false,
	}
	var mu sync.Mutex
	set := func(key string, value any) { mu.Lock(); result[key] = value; mu.Unlock() }
	deadline := time.AfterFunc(45*time.Second, func() { set("timedOut", true); mygo.App.Quit() })
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{Title: "HE-Music System Media Probe", Width: 1000, Height: 740,
			Page: mygo.PageOptions{PreloadScript: `localStorage.setItem("shortcut-store", JSON.stringify({globalOpen:false}));
localStorage.setItem("setting-store", JSON.stringify({smtcOpen:false,preventSleep:false}));
window.__systemMediaErrors={errors:0,rejections:0};
addEventListener("error",e=>{if(e.target===window)window.__systemMediaErrors.errors++});
addEventListener("unhandledrejection",()=>window.__systemMediaErrors.rejections++);`}})
		desktopLifecycle.attachMainWindow(win, true)
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					stage := "shell-ready-disabled"
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
					if !wait(func() bool {
						return desktopLifecycle.state.ready() && desktopSystemMedia.state.owner != nil &&
							!desktopSystemMedia.state.enabled && !desktopSystemMedia.state.showing &&
							desktopSystemMedia.state.releasePower == nil && media.sets == 0 && power.acquires == 0
					}) {
						return
					}
					set("fixtureInitiallyDisabled", true)
					stage = "enable-explicit-fixture"
					if !eval(`(async()=>{window.__systemMediaProbe=await(await import("/src/nativeprobe/systemMedia.ts")).prepareSystemMediaProbe();return await window.__systemMediaProbe.enable()})()`) {
						return
					}
					if !wait(func() bool {
						return desktopSystemMedia.state.showing && desktopSystemMedia.state.off != nil && media.playbacks > 0 && power.acquires == 1 && power.releases == 0
					}) {
						return
					}
					set("metadataAPIAndLeaseRequested", true)
					stage = "artwork-typed-loader-and-module"
					const expectedArtworkSHA256 = "ae00e91d2d1a4b131307b6a553d83e66152273ed5747e2d7b9ce99a18c5d17a9"
					if !wait(func() bool {
						info, showing := media.Info()
						return showing && len(info.Artwork) == 88 && fmt.Sprintf("%x", sha256.Sum256(info.Artwork)) == expectedArtworkSHA256 && info.Rate == 1.25 && info.State == mygo.PlaybackPaused
					}) {
						return
					}
					var artworkBytes int
					mygo.RunOnMain(func() {
						info, _ := media.Info()
						artworkBytes = len(info.Artwork)
						set("artworkModuleBytes", artworkBytes)
						set("artworkModuleSHA256", fmt.Sprintf("%x", sha256.Sum256(info.Artwork)))
					})
					set("artworkExpectedSHA256", expectedArtworkSHA256)
					set("artworkBytesMatchSyntheticFixture", true)
					set("artwork", "synthetic-png-through-typed-session")
					if !eval(`window.__systemMediaProbe.artworkRate()`) {
						return
					}
					if !wait(func() bool {
						info, showing := media.Info()
						return showing && len(info.Artwork) == artworkBytes && fmt.Sprintf("%x", sha256.Sum256(info.Artwork)) == expectedArtworkSHA256 && info.Rate == 2.5 && info.State == mygo.PlaybackPaused
					}) {
						return
					}
					set("artworkRetainedForNewRateRevision", true)
					stage = "clock-isolation"
					var initialSets, initialSubscriptions, initialPlayback int
					mygo.RunOnMain(func() {
						initialSets, initialSubscriptions, initialPlayback = media.sets, media.subscriptions, media.playbacks
					})
					if !eval(`(async()=>{await window.__systemMediaProbe.clock();await new Promise(r=>setTimeout(r,100));return true})()`) {
						return
					}
					if !wait(func() bool {
						return media.sets == initialSets && media.subscriptions == initialSubscriptions && media.playbacks == initialPlayback && power.acquires == 1
					}) {
						return
					}
					set("unrelatedClockNoAPIWrites", true)
					stage = "programmatic-callback-to-fixture-entries"
					for index, command := range []mygo.MediaCommand{mygo.MediaPlay, mygo.MediaPause, mygo.MediaSeek} {
						mygo.RunOnMain(func() { media.callback(command, 0) })
						if !eval(fmt.Sprintf(`(async()=>{for(let i=0;i<30&&window.__systemMediaProbe.calls().length!==%d;i++)await new Promise(r=>setTimeout(r,30));return window.__systemMediaProbe.calls().length===%d})()`, index+1, index+1)) {
							return
						}
					}
					if !eval(`JSON.stringify(window.__systemMediaProbe.calls())===JSON.stringify(["play","pause","seek:0"])`) {
						return
					}
					set("callbackProgrammaticallyInvoked", true)
					set("seekZeroFixtureEntry", true)
					stage = "media-off-power-independent"
					if !eval(`window.__systemMediaProbe.mediaOff()`) {
						return
					}
					if !wait(func() bool {
						return !desktopSystemMedia.state.showing && desktopSystemMedia.state.off == nil && desktopSystemMedia.state.releasePower != nil && power.acquires == 1 && power.releases == 0
					}) {
						return
					}
					set("mediaOffRetainsLease", true)
					if !wait(func() bool {
						_, showing := media.Info()
						return !showing
					}) {
						return
					}
					set("artworkModuleClearedWhenDisabled", true)
					mygo.RunOnMain(func() { media.callback(mygo.MediaPlay, 0) })
					if !eval(`(async()=>{await new Promise(r=>setTimeout(r,80));return window.__systemMediaProbe.calls().length===3})()`) {
						return
					}
					set("staleCallbackIgnored", true)
					stage = "media-reenabled"
					if !eval(`window.__systemMediaProbe.mediaOn()`) {
						return
					}
					if !wait(func() bool { return desktopSystemMedia.state.showing && power.acquires == 1 && power.releases == 0 }) {
						return
					}
					set("mediaReenabledWithoutNewLease", true)
					stage = "disable-release-clear"
					if !eval(`window.__systemMediaProbe.disable()`) {
						return
					}
					if !wait(func() bool {
						return !desktopSystemMedia.state.showing && desktopSystemMedia.state.off == nil && desktopSystemMedia.state.releasePower == nil && power.releases == 1
					}) {
						return
					}
					set("disabledClearedAndReleased", true)
					stage = "cleanup"
					if !eval(`(async()=>{await window.__systemMediaProbe.cleanup();return window.__systemMediaErrors.errors===0&&window.__systemMediaErrors.rejections===0})()`) {
						return
					}
					if !wait(func() bool {
						return desktopSystemMedia.state.owner == nil && desktopSystemMedia.state.releasePower == nil && media.subscriptions == media.removals && power.releases == 1
					}) {
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
	set("nativeResourcesCleaned", desktopSystemMedia.state.owner == nil && desktopSystemMedia.state.off == nil && desktopSystemMedia.state.releasePower == nil && desktopLifecycle.state.cleaned)
	set("realAPICallCounts", map[string]int{"set": media.sets, "playback": media.playbacks, "clear": media.clears, "subscribe": media.subscriptions, "off": media.removals, "powerAcquire": power.acquires, "powerRelease": power.releases})
	mu.Lock()
	result["passed"] = result["checksComplete"] == true && result["nativeResourcesCleaned"] == true && result["timedOut"] != true && result["runFailed"] != true
	encoded, err := json.MarshalIndent(result, "", "  ")
	mu.Unlock()
	if err != nil {
		log.Fatal("system media result encoding failed")
	}
	if err = os.WriteFile(filepath.Join(output, "result.json"), encoded, 0o600); err != nil {
		log.Fatal("system media result write failed")
	}
	fmt.Println(string(encoded))
}
