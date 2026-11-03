//go:build nativeprobe && !lifecycleprobe && !shortcutprobe && !mediaprobe && !fileprobe

package main

// This opt-in executable replaces main only in builds with -tags=nativeprobe.
// It never runs in production builds and reports only DOM counts and booleans.

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

func main() {
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if os.Getenv("HE_MUSIC_NATIVE_PROBE") != "1" {
		log.Fatal("nativeprobe requires HE_MUSIC_NATIVE_PROBE=1")
	}
	output := os.Getenv("HE_MUSIC_NATIVE_PROBE_OUTPUT")
	if output == "" || !filepath.IsAbs(output) {
		log.Fatal("nativeprobe requires an absolute HE_MUSIC_NATIVE_PROBE_OUTPUT directory")
	}
	if err := os.MkdirAll(output, 0o700); err != nil {
		log.Fatal(err)
	}
	dataDir, err := os.MkdirTemp("", "hemusic-nativeprobe-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dataDir)
	mygo.App.SetName("HE-Music Native Probe")
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	// A unique host isolates WebKit storage from the normal app origin.
	pageURL := fmt.Sprintf("mygo://m2-probe-%d/", time.Now().UnixNano())
	var proxy *http.Server
	if mygo.IsDev() {
		// A fresh loopback port isolates dev storage while exercising the actual
		// mygo dev server, including Vite's module and WebSocket URLs.
		target, err := url.Parse(os.Getenv("MYGO_DEV_URL"))
		if err != nil || target.Hostname() != "127.0.0.1" {
			log.Fatal("nativeprobe requires the configured loopback dev server")
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
		proxy = &http.Server{Handler: httputil.NewSingleHostReverseProxy(target), ReadHeaderTimeout: 5 * time.Second}
		defer proxy.Close()
		go func() { _ = proxy.Serve(listener) }()
		pageURL = "http://" + listener.Addr().String() + "/"
	}

	result := map[string]any{"passed": false, "engine": "macOS WKWebView", "development": mygo.IsDev()}
	var resultMu sync.Mutex
	setResult := func(key string, value any) {
		resultMu.Lock()
		result[key] = value
		resultMu.Unlock()
	}
	deadline := time.AfterFunc(45*time.Second, func() {
		setResult("timedOut", true)
		mygo.App.Quit()
	})
	defer deadline.Stop()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "HE-Music Native Probe", Width: 1280, Height: 800,
			Page: mygo.PageOptions{PreloadScript: nativePublicRequestObserver + `
window.__m2Probe = { errors: 0, rejections: 0, resourceErrors: 0, errorDiagnostics: [] };
addEventListener("error", (event) => {
  if (event.target === window) {
    window.__m2Probe.errors++;
    let source = "external-or-runtime";
    try {
      const url = new URL(event.filename);
      if (url.origin === location.origin &&
          (url.pathname.startsWith("/src/") || url.pathname.startsWith("/node_modules/"))) {
        source = url.pathname.split("/").at(-1) || source;
      }
    } catch {}
    window.__m2Probe.errorDiagnostics.push({
      category: String(event.message || "").includes("ResizeObserver") ? "resize-observer-loop" :
        (event.message === "Script error." || event.message === "Script error") ? "cross-origin-script-error" : "unclassified",
      name: event.error?.name || "ErrorEvent",
      source,
      line: event.lineno || 0,
      constructor: event.constructor?.name || "unknown",
      trusted: event.isTrusted,
      hasMessage: !!event.message,
      stage: window.__m2Probe.stage,
    });
  } else window.__m2Probe.resourceErrors++;
}, true);
addEventListener("unhandledrejection", () => window.__m2Probe.rejections++);
`},
		})
		desktopLifecycle.attachMainWindow(win, false)
		var once sync.Once
		win.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					defer win.Close()
					value, err := win.Page().Eval(`(async () => {
  const until = async (predicate) => {
    const end = Date.now() + 20000;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error("probe condition timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  window.__m2Probe.stage = "vue-root";
  await until(() => document.querySelector("#app-layout") && document.querySelector("#main-header"));
  await document.fonts.ready;
  const fontResponse = await fetch("/fonts/logo.woff2");
  const iconResponse = await fetch("/icons/favicon.ico");
  const initial = {
    vueRoot: !!document.querySelector("#app").__vue_app__,
    layout: !!document.querySelector("#app-layout"),
    header: !!document.querySelector("#main-header"),
    visible: document.querySelector("#app-layout").getBoundingClientRect().height > 0,
    fontBytes: (await fontResponse.arrayBuffer()).byteLength,
    fontOK: fontResponse.ok,
    iconOK: iconResponse.ok,
    platform: window.mygo.platform,
    electronAbsent: typeof window.electron === "undefined"
  };
  let maximizeEvents = 0;
  const offMaximized = window.mygo.on("desktop:window-maximized", () => maximizeEvents++);
  window.__m2Probe.stage = "maximize";
  const initialMax = await window.mygo.window.isMaximized();
  await window.mygo.window.toggleMaximize();
  await until(async () => (await window.mygo.window.isMaximized()) !== initialMax);
  const changedMax = await window.mygo.window.isMaximized();
  window.__m2Probe.stage = "maximize-event";
  await until(() => maximizeEvents > 0);
  offMaximized();
  const eventsBeforeRestore = maximizeEvents;
  window.__m2Probe.stage = "restore";
  await window.mygo.window.toggleMaximize();
  await until(async () => (await window.mygo.window.isMaximized()) === initialMax);
  window.__m2Probe.stage = "router-ready";
  const router = document.querySelector("#app").__vue_app__.config.globalProperties.$router;
  await router.isReady();
  window.__m2Probe.stage = "setting-route";
  await router.push("/setting");
  await until(() => document.querySelector(".setting"));
  await new Promise(resolve => setTimeout(resolve, 500));
  return { ...initial, publicRequests: window.__nativePublicRequests ?? [], route: location.hash, setting: !!document.querySelector(".setting"),
    maximizeChanged: initialMax !== changedMax, eventReceived: eventsBeforeRestore > 0,
    eventUnsubscribed: maximizeEvents === eventsBeforeRestore, ...window.__m2Probe };
})()`)
					if err != nil {
						diagnostic, diagnosticErr := win.Page().Eval(`(async () => ({
  stage: window.__m2Probe?.stage,
  errors: window.__m2Probe?.errors,
  rejections: window.__m2Probe?.rejections,
  resourceErrors: window.__m2Probe?.resourceErrors,
  appMounted: !!document.querySelector("#app")?.__vue_app__,
  settingMounted: !!document.querySelector(".setting"),
  settingRoute: location.hash === "#/setting",
  readyState: document.readyState,
  maximized: await window.mygo.window.isMaximized()
}))()`)
						setResult("diagnosticEvalOK", diagnosticErr == nil)
						failurePNG, failureErr := win.CapturePage()
						if failureErr == nil {
							failureErr = os.WriteFile(filepath.Join(output, "wkwebview-failure.png"), failurePNG, 0o600)
						}
						setResult("failureScreenshotSaved", failureErr == nil && len(failurePNG) > 0)
						setResult("diagnostic", diagnostic)
						setResult("evalFailed", true)
						return
					}
					setResult("page", value)
					finalRuntime := nativeDiagnosticCheckpoint(win, "page-complete")
					setResult("postPageRuntime", finalRuntime)
					mediaResult := map[string]any{"passed": false, "diagnosticOnlySkipped": true}
					if os.Getenv("HE_MUSIC_NATIVE_DIAGNOSTIC") != "1" {
						mediaResult = runMediaNativeProbe(win, output)
					}
					setResult("mediaIntegration", mediaResult)
					png, err := win.CapturePage()
					if err == nil {
						err = os.WriteFile(filepath.Join(output, "wkwebview.png"), png, 0o600)
					}
					screenshotSaved := err == nil && len(png) > 0
					windowVisible := win.IsVisible()
					setResult("screenshotSaved", screenshotSaved)
					setResult("windowVisible", windowVisible)
					page, ok := value.(map[string]any)
					passed := ok && windowVisible && screenshotSaved &&
						page["vueRoot"] == true && page["layout"] == true &&
						page["visible"] == true && page["header"] == true &&
						page["setting"] == true && page["platform"] == "darwin" &&
						page["fontOK"] == true && page["iconOK"] == true &&
						page["electronAbsent"] == true && page["maximizeChanged"] == true &&
						page["eventReceived"] == true && page["eventUnsubscribed"] == true &&
						page["errors"] == float64(0) && page["rejections"] == float64(0) &&
						page["resourceErrors"] == float64(0)
					passed = passed && nativeDiagnosticRuntimeClean(finalRuntime)
					passed = passed && (mediaResult["passed"] == true || mediaResult["developmentOnlySkipped"] == true || mediaResult["diagnosticOnlySkipped"] == true)
					setResult("passed", passed)
				}()
			})
		})
		win.Page().LoadURL(pageURL)
	})
	if err := mygo.App.Run(); err != nil {
		setResult("runFailed", true)
	}
	resultMu.Lock()
	if result["timedOut"] == true || result["runFailed"] == true {
		result["passed"] = false
	}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	resultMu.Unlock()
	if err := os.WriteFile(filepath.Join(output, "result.json"), encoded, 0o600); err != nil {
		log.Fatal(err)
	}
	fmt.Println(string(encoded))
}
