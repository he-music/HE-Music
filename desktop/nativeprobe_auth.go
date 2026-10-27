//go:build nativeprobe

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/egoist/mygo"
)

// Observe only the two public requests the shared app already makes. Never retain
// URLs, headers, response bodies, credentials, or unrelated request metadata.
const nativeAuthRequestObserver = `
(() => {
  window.__m3PublicRequests = [];
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, rawURL, ...rest) {
    let category;
    try {
      const path = new URL(rawURL, location.href).pathname;
      if (path.endsWith("/v1/auth/providers")) category = "providers";
      if (path.endsWith("/v1/platforms")) category = "platforms";
    } catch {}
    if (category && String(method).toUpperCase() === "GET") {
      this.addEventListener("loadend", () => {
        const entry = { category, status: this.status,
          corsReadable: this.status > 0 };
        if (category === "providers" && this.status >= 200 && this.status < 300) {
          try {
            const body = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            if (Array.isArray(body.list)) entry.providerCount = body.list.length;
          } catch {}
        }
        window.__m3PublicRequests.push(entry);
      }, { once: true });
    }
    return originalOpen.call(this, method, rawURL, ...rest);
  };
})();
`

// Exercise the production binding and directed event in WKWebView. The only
// HTTP caller is Go; no backend session or token exchange is created here.
func runAuthNativeProbe(win *mygo.Window) map[string]any {
	result := map[string]any{"passed": false, "syntheticOnly": true}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		result["stage"] = "allocate-port"
		return result
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	sequence := 0
	checkpoints := []any{}
	result["evalCheckpoints"] = checkpoints
	eval := func(script string) (any, bool) {
		sequence++
		label := fmt.Sprintf("auth-eval-%d", sequence)
		before := nativeDiagnosticCheckpoint(win, label+"-before")
		value, err := win.Page().Eval(script)
		after := nativeDiagnosticCheckpoint(win, label+"-after")
		checkpoints = append(checkpoints, map[string]any{"operation": label, "before": before, "after": after, "evalOK": err == nil})
		result["evalCheckpoints"] = checkpoints
		return value, err == nil
	}
	defer func() {
		_, _ = eval(`(async () => {
  const p = window.__m3AuthProbe;
  if (!p) return;
  p.off?.();
  if (p.current) await window.mygo.call("AuthCallback.Cancel", p.current.sessionId).catch(() => {});
  delete window.__m3AuthProbe;
})()`)
	}()
	_, ok := eval(`(() => {
window.__m3AuthProbe = { events: [], accepted: 0, current: null };
window.__m3AuthProbe.off = window.mygo.on("desktop:auth-callback", event => {
  const p = window.__m3AuthProbe;
  p.events.push({ sessionId: event.sessionId, state: event.state });
  if (p.current && event.sessionId === p.current.sessionId && event.state === p.state) {
    p.accepted++;
  }
}); return true;
})()`)
	if !ok {
		result["stage"] = "subscribe"
		return result
	}
	prepare := func(state string) (AuthCallbackPrepared, bool) {
		encoded, _ := json.Marshal(state)
		value, ok := eval(fmt.Sprintf(`(async () => {
  const p = window.__m3AuthProbe;
  p.current = await window.mygo.call("AuthCallback.Prepare", %d);
  p.state = %s;
  await window.mygo.call("AuthCallback.Arm", p.current.sessionId, p.state, Date.now() + 15000);
  return p.current;
})()`, port, encoded))
		if !ok {
			return AuthCallbackPrepared{}, false
		}
		data, err := json.Marshal(value)
		var prepared AuthCallbackPrepared
		if err != nil || json.Unmarshal(data, &prepared) != nil {
			return prepared, false
		}
		parsed, err := url.Parse(prepared.CallbackURL)
		return prepared, err == nil && parsed.Scheme == "http" && parsed.Host == fmt.Sprintf("127.0.0.1:%d", port) && parsed.Path == authCallbackPath && prepared.SessionID != ""
	}
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	callback := func(prepared AuthCallbackPrepared, state string) int {
		response, err := client.Get(prepared.CallbackURL + "?state=" + url.QueryEscape(state))
		if err != nil {
			return 0 // listener closed; no response body or URL is logged
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	portReleased := func() bool {
		probe, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return false
		}
		_ = probe.Close()
		return true
	}
	first, ok := prepare("he-music-nativeprobe-cancelled-state")
	if !ok {
		result["stage"] = "prepare-cancelled"
		return result
	}
	result["wrongStateStatus"] = callback(first, "he-music-nativeprobe-wrong-state")
	_, ok = eval(`(async () => {
  const p = window.__m3AuthProbe;
  await window.mygo.call("AuthCallback.Cancel", p.current.sessionId);
  p.current = null;
  return true;
})()`)
	result["cancelBinding"] = ok
	result["cancelReleasedPort"] = portReleased()
	result["cancelledLateStatus"] = callback(first, "he-music-nativeprobe-cancelled-state")
	second, ok := prepare("he-music-nativeprobe-success-state")
	if !ok {
		result["stage"] = "prepare-success"
		return result
	}
	result["replacementLateStatus"] = callback(first, "he-music-nativeprobe-cancelled-state")
	value, ok := eval(`({ count: window.__m3AuthProbe.events.length, accepted: window.__m3AuthProbe.accepted })`)
	counts, _ := value.(map[string]any)
	result["wrongAndCancelledIgnored"] = ok && counts["count"] == float64(0) && counts["accepted"] == float64(0)
	result["successStatus"] = callback(second, "he-music-nativeprobe-success-state")
	value, ok = eval(`(async () => {
  const p = window.__m3AuthProbe;
  const end = Date.now() + 3000;
  while (!p.events.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  return { matched: p.events.length === 1 && p.events[0].sessionId === p.current.sessionId &&
    p.events[0].state === p.state && p.accepted === 1 };
})()`)
	matched, _ := value.(map[string]any)
	result["sessionAndStateMatched"] = ok && matched["matched"] == true
	result["successReleasedPort"] = portReleased()
	result["duplicateStatus"] = callback(second, "he-music-nativeprobe-success-state")
	_, ok = eval(`(() => { window.__m3AuthProbe.off(); window.__m3AuthProbe.current = null; return true; })()`)
	result["unsubscribeCalled"] = ok
	third, ok := prepare("he-music-nativeprobe-unsubscribed-state")
	if !ok {
		result["stage"] = "prepare-unsubscribed"
		return result
	}
	result["unsubscribedCallbackStatus"] = callback(third, "he-music-nativeprobe-unsubscribed-state")
	value, ok = eval(`(async () => {
  await new Promise(resolve => setTimeout(resolve, 250));
  const p = window.__m3AuthProbe;
  return { singleEvent: p.events.length === 1 && p.accepted === 1,
    publicRequests: window.__m3PublicRequests ?? [] };
})()`)
	final, _ := value.(map[string]any)
	result["onlyOneEventAndUnsubscribed"] = ok && final["singleEvent"] == true
	result["publicRequests"] = final["publicRequests"]
	result["unsubscribedReleasedPort"] = portReleased()
	result["passed"] = result["wrongStateStatus"] == 400 && result["cancelBinding"] == true &&
		result["cancelReleasedPort"] == true && result["cancelledLateStatus"] == 0 &&
		result["replacementLateStatus"] == 400 && result["wrongAndCancelledIgnored"] == true &&
		result["successStatus"] == 200 && result["sessionAndStateMatched"] == true &&
		result["successReleasedPort"] == true && result["duplicateStatus"] == 0 &&
		result["unsubscribeCalled"] == true && result["unsubscribedCallbackStatus"] == 200 &&
		result["onlyOneEventAndUnsubscribed"] == true && result["unsubscribedReleasedPort"] == true
	return result
}
