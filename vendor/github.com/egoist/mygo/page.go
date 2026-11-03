package mygo

import (
	"image/color"

	"github.com/egoist/mygo/internal/platform"
)

// Page is the web page a window shows: what it loads, the scripts it runs,
// its developer tools and its events. A window showing native UI
// (WindowOptions.Content) has none.
//
//	win := mygo.NewWindow(mygo.WindowOptions{Title: "Editor", URL: "/"})
//	win.Page().OnDOMReady(func() { log.Println("ready") })
//
// Like the window's, its methods are safe from any goroutine.
type Page struct{ w *Window }

// Page returns the web page the window shows, or nil for a window that
// shows native UI.
func (w *Window) Page() *Page {
	if w.content != nil {
		return nil
	}
	return w.pg
}

// Window returns the window that shows the page: for the page of a web
// view, the window the web view is in.
func (p *Page) Window() *Window { return p.w.top() }

// WebView returns the web view whose page this is, nil for the page of a
// window.
func (p *Page) WebView() *WebView { return p.w.webView }

// ThemeColor returns the page's theme color, and false when it has none:
// the content of the first <meta name="theme-color"> in the page's head
// whose media attribute is absent or matches, and whose content is a CSS
// color, as browsers pick it. A page with one for light and one for dark
// appearance,
//
//	<meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">
//	<meta name="theme-color" content="#111" media="(prefers-color-scheme: dark)">
//
// has the one of the app's appearance (Theme). The color is 8-bit sRGB
// with straight alpha, as the page's engine computes it, whatever the CSS
// syntax: ui.RGB(c.R, c.G, c.B) makes it a ui.Color.
//
// MyGo's runtime in the page tells it, on every platform alike, in pages of
// any origin, trusted or not; a page it doesn't run in, such as an image
// or a PDF, has none. A page that just started loading still has the color
// of the one before until its DOM is ready, so that going between pages of
// the same color changes nothing.
func (p *Page) ThemeColor() (c color.NRGBA, ok bool) {
	onMain(func() {
		if p.w.native != nil && p.w.hasThemeColor {
			c, ok = nrgba(p.w.themeColor), true
		}
	})
	return c, ok
}

// OnThemeColorChanged is called when the page's theme color (ThemeColor)
// changed, with ok false when it has none any more: its meta was added,
// removed or changed, the app's appearance changed and another meta's
// media matches, or another page has another color. It is called on the
// main thread, as other events are, and only when the color changed.
//
//	page.OnThemeColorChanged(func(c color.NRGBA, ok bool) {
//		if ok {
//			toolbar.SetBackground(ui.RGB(c.R, c.G, c.B))
//		}
//	})
func (p *Page) OnThemeColorChanged(fn func(c color.NRGBA, ok bool)) (off func()) {
	return p.w.onThemeColorChanged.add(fn, false)
}

// setThemeColor sets the page's theme color, as its bridge told it, and
// tells the listeners if it changed. Main thread only.
func (w *Window) setThemeColor(c platform.Color, ok bool) {
	w.themeColorPending = false
	if !ok {
		c = platform.Color{}
	}
	if ok == w.hasThemeColor && c == w.themeColor {
		return
	}
	w.themeColor, w.hasThemeColor = c, ok
	for _, fn := range w.onThemeColorChanged.snapshot() {
		fn(nrgba(c), ok)
	}
}

// themeColorSettled runs once the page loaded, or failed to: a page whose
// bridge did not tell its theme color since its navigation committed has
// none. Main thread only.
func (w *Window) themeColorSettled() {
	if w.themeColorPending {
		w.setThemeColor(platform.Color{}, false)
	}
}

// IsAudible reports whether the page is making sound: a video or audio
// element playing, Web Audio, from any of its frames, those of other
// sites included. Like a browser tab's speaker icon, it can stay true
// while the page is muted (SetAudioMuted); the platform decides when a
// paused or silent source stops counting. It is false for a window
// showing native UI and after the window closed, and where the platform
// can't tell:
//
//   - macOS: WebKit's private -[WKWebView _isPlayingAudio], looked up with
//     respondsToSelector:; false when WebKit doesn't answer it.
//   - Linux: webkit_web_view_is_playing_audio.
//   - Windows: ICoreWebView2_8's IsDocumentPlayingAudio; false on WebView2
//     runtimes older than it.
func (p *Page) IsAudible() bool { return pageGet(p.w, platform.Window.IsAudible) }

// OnAudibleChanged is called when the page starts or stops making sound
// (IsAudible), on the main thread, as other events are: to show a speaker
// on a tab or offer to mute a window. It is never called where IsAudible
// is always false.
//
//	page.OnAudibleChanged(func(audible bool) {
//		tab.SetSpeakerVisible(audible)
//	})
func (p *Page) OnAudibleChanged(fn func(audible bool)) (off func()) {
	return p.w.onAudibleChanged.add(fn, false)
}

// SetAudioMuted mutes all the page's sound, or lets it play again, as a
// browser mutes a tab: the page's own media elements, Web Audio and its
// frames of other sites, without the page seeing its elements muted. It
// lasts as the page navigates, until it is set again, and a page muted
// before its web view is ready starts muted. It does nothing for a window
// showing native UI and where the platform can't mute:
//
//   - macOS: WebKit's private -[WKWebView _setPageMuted:], as Safari mutes a
//     tab, looked up with respondsToSelector:; nothing when WebKit doesn't
//     answer it.
//   - Linux: webkit_web_view_set_is_muted, WebKitGTK 2.30 or later.
//   - Windows: ICoreWebView2_8's IsMuted; nothing on WebView2 runtimes
//     older than it.
func (p *Page) SetAudioMuted(muted bool) {
	p.w.page(func(n platform.Window) { n.SetAudioMuted(muted) })
}

// IsAudioMuted reports whether the page is muted (SetAudioMuted): false
// where the platform can't mute, for a window showing native UI and after
// the window closed.
func (p *Page) IsAudioMuted() bool { return pageGet(p.w, platform.Window.IsAudioMuted) }

func nrgba(c platform.Color) color.NRGBA { return color.NRGBA{R: c.R, G: c.G, B: c.B, A: c.A} }

// PageOptions configure the web page of a window.
type PageOptions struct {
	// PreloadScript is JavaScript injected into every page before the
	// page's own scripts, after window.mygo is available.
	PreloadScript string
	// TrustedOrigins lists extra origins, such as "https://example.com",
	// whose pages may call bound Go methods. By default only the app's own
	// content can: custom schemes registered with Protocol, file: and
	// about: pages, and loopback dev servers during development. "*"
	// trusts every origin.
	TrustedOrigins []string
	// DevTools controls the web inspector, and for a window showing
	// Content, the inspector of its native UI.
	DevTools DevTools
	// ZoomFactor of the page (default 1).
	ZoomFactor float64
	// UserAgent overrides the user agent string.
	UserAgent string
	// SafariTabFocus leaves Tab to text fields and elements with a
	// tabindex, as Safari does while the system's keyboard navigation
	// (System Settings › Keyboard › Keyboard navigation) is off (macOS).
	// By default Tab reaches links, buttons, checkboxes and selects too,
	// as it does in Chrome, Electron and WebView2.
	SafariTabFocus bool
	// UserAgentSuffix appends to the page's user agent instead of
	// replacing it, as UserAgent does: the app's name and version, such as
	// "MyApp/1.2", for the sites that read them. It appends to UserAgent
	// too, which SetUserAgent keeps as well; leading and trailing spaces
	// are trimmed. Some sites serve a bare web view, whose user agent
	// names no browser, older pages: "Version/17.0 Safari/605.1.15" makes the
	// page look like Safari.
	UserAgentSuffix string
	// ContentRules block what the page loads and hide parts of it, as
	// Page.SetContentRules does, from its first load.
	ContentRules []*ContentRules
}
