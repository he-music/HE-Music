package main

import (
	"errors"
	"net/url"

	"github.com/egoist/mygo"
)

// DesktopPlatform exposes only the desktop capabilities implemented in M2.
type DesktopPlatform struct{}

// OpenExternal opens HTTP(S) links in the system browser.
func (*DesktopPlatform) OpenExternal(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("external links must use HTTP or HTTPS")
	}
	return mygo.Shell.OpenExternal(parsed.String())
}

var windowMaximized = mygo.NewEvent[bool]("desktop:window-maximized")

func init() {
	mygo.Bind(&DesktopPlatform{})
	mygo.App.OnWindowCreated(func(win *mygo.Window) {
		offMax := win.OnMaximize(func() { _ = windowMaximized.EmitPage(win.Page(), true) })
		offRestore := win.OnUnmaximize(func() { _ = windowMaximized.EmitPage(win.Page(), false) })
		win.OnClosed(func() {
			offMax()
			offRestore()
		})
	})
	// M2 has no tray or dock activation flow; closing the last window must exit.
	mygo.App.OnWindowAllClosed(func() { mygo.App.Quit() })
}
