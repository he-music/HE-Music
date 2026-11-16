//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/egoist/mygo/internal/platform"
	"github.com/egoist/mygo/transfer"
)

// Clipboard (NSPasteboard).

type clipboard struct{}

const (
	utString = "public.utf8-plain-text"
	utHTML   = "public.html"
	utPNG    = "public.png"
	utTIFF   = "public.tiff"
)

func pasteboard() id { return send(class("NSPasteboard"), "generalPasteboard") }

func (clipboard) ReadText() string {
	var s string
	withPool(func() { s = goString(send(pasteboard(), "stringForType:", uintptr(nsString(utString)))) })
	return s
}

func (c clipboard) WriteText(text string) { _ = c.WriteData(transfer.TextData(text), false, nil) }

func (clipboard) ReadHTML() string {
	var s string
	withPool(func() { s = goString(send(pasteboard(), "stringForType:", uintptr(nsString(utHTML)))) })
	return s
}

func (c clipboard) WriteHTML(markup string) {
	_ = c.WriteData(transfer.New(transfer.NewItem(transfer.Bytes(transfer.HTML, []byte(markup)), transfer.Bytes(transfer.Text, []byte(markup)))), false, nil)
}

func (clipboard) ReadImage() []byte {
	var out []byte
	withPool(func() {
		pb := pasteboard()
		if data := send(pb, "dataForType:", uintptr(nsString(utPNG))); data != 0 {
			out = goBytes(data)
			return
		}
		if data := send(pb, "dataForType:", uintptr(nsString(utTIFF))); data != 0 {
			rep := send(class("NSBitmapImageRep"), "imageRepWithData:", uintptr(data))
			if rep != 0 {
				out = goBytes(send(rep, "representationUsingType:properties:", 4, uintptr(send(class("NSDictionary"), "dictionary"))))
			}
		}
	})
	return out
}

func (c clipboard) WriteImage(png []byte) error {
	var err error
	withPool(func() {
		img := autorelease(send(send(class("NSImage"), "alloc"), "initWithData:", uintptr(nsData(png))))
		if img == 0 {
			err = errInvalidImage
		}
	})
	if err != nil {
		return err
	}
	return c.WriteData(transfer.New(transfer.NewItem(transfer.Bytes(transfer.PNG, png))), false, nil)
}
func (clipboard) Clear() {
	withPool(func() {
		send(pasteboard(), "clearContents")
		if s := macClipboard; s != nil {
			s.release()
		}
	})
}

func (clipboard) AvailableFormats() []string {
	var out []string
	withPool(func() {
		for _, t := range arrayItems(send(pasteboard(), "types")) {
			out = append(out, goString(t))
		}
	})
	return out
}

// Shell (NSWorkspace).

type shell struct{}

func workspace() id { return send(class("NSWorkspace"), "sharedWorkspace") }

func (shell) OpenExternal(url string) error {
	var err error
	withPool(func() {
		u := nsURL(url)
		if u == 0 {
			err = fmt.Errorf("mygo: invalid URL %q", url)
			return
		}
		if !sendBool(workspace(), "openURL:", uintptr(u)) {
			err = fmt.Errorf("mygo: no application can open %q", url)
		}
	})
	return err
}

func (shell) OpenPath(path string) error {
	var err error
	withPool(func() {
		if !sendBool(workspace(), "openURL:", uintptr(fileURL(path))) {
			err = fmt.Errorf("mygo: cannot open %q", path)
		}
	})
	return err
}

func (shell) ShowItemInFolder(path string) {
	withPool(func() {
		send(workspace(), "activateFileViewerSelectingURLs:", uintptr(nsArray(fileURL(path))))
	})
}

func (shell) TrashItem(path string) error {
	var err error
	withPool(func() {
		var nserr id
		fm := send(class("NSFileManager"), "defaultManager")
		if !sendBool(fm, "trashItemAtURL:resultingItemURL:error:", uintptr(fileURL(path)), 0, uintptr(unsafe.Pointer(&nserr))) {
			err = nsError(nserr)
			if err == nil {
				err = errors.New("mygo: cannot move to trash")
			}
		}
	})
	return err
}

// Quick Look: QLPreviewPanel is the panel Finder opens with the space bar.
// The app does not link QuickLook, so the framework is opened on first use,
// before its class and data source protocol can be looked up.

var (
	quickLookOnce sync.Once
	quickLookErr  error
	// previewSource is the retained data source; the panel keeps its data
	// source unretained, so this one lives as long as the process.
	previewSource id
	previewURLMu  sync.RWMutex
	previewURL    id
)

// loadQuickLook opens QuickLook.framework.
func loadQuickLook() error {
	quickLookOnce.Do(func() {
		_, quickLookErr = purego.Dlopen("/System/Library/Frameworks/QuickLook.framework/QuickLook", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	})
	return quickLookErr
}

// previewDataSource returns the object QLPreviewPanel asks for the item to
// show: one item, the retained URL of the last PreviewItem call.
func previewDataSource() id {
	if previewSource != 0 {
		return previewSource
	}
	cls := classDef("MyGoPreviewDataSource", "NSObject", []string{"QLPreviewPanelDataSource"}, []objc.MethodDef{
		method("numberOfPreviewItemsInPreviewPanel:", func(self id, _ objc.SEL, panel id) int { return 1 }),
		method("previewPanel:previewItemAtIndex:", func(self id, _ objc.SEL, panel id, index int) id {
			previewURLMu.RLock()
			defer previewURLMu.RUnlock()
			return previewURL
		}),
	})
	previewSource = retain(send(send(cls, "alloc"), "init"))
	return previewSource
}

// PreviewItem shows the item at path in the Quick Look panel, as Finder's
// space bar does. The panel stays open until the user closes it; asking
// again replaces the item it shows.
func (shell) PreviewItem(path string) error {
	if err := loadQuickLook(); err != nil {
		return fmt.Errorf("mygo: cannot load Quick Look: %w", err)
	}
	var err error
	withPool(func() {
		if !hasClass("QLPreviewPanel") {
			err = platform.ErrUnsupported
			return
		}
		src := previewDataSource()
		u := retain(fileURL(path))
		previewURLMu.Lock()
		old := previewURL
		previewURL = u
		previewURLMu.Unlock()
		release(old)
		panel := send(class("QLPreviewPanel"), "sharedPreviewPanel")
		send(panel, "setDataSource:", uintptr(src))
		send(panel, "reloadData")
		if theBackend != nil {
			send(theBackend.app, "activateIgnoringOtherApps:", 1)
		}
		send(panel, "makeKeyAndOrderFront:", 0)
	})
	return err
}

func (shell) Beep() { nsBeep() }

// DefaultApp returns the application the system would use to open url.
// url may be a web URL (https://example.com), a file:// URL, or any URL
// whose scheme is registered with Launch Services. The name, bundle
// identifier and path of the .app bundle are returned.
func (shell) DefaultApp(url string) (platform.Application, error) {
	var app platform.Application
	var err error
	withPool(func() {
		u := nsURL(url)
		if u == 0 {
			err = fmt.Errorf("mygo: invalid URL %q", url)
			return
		}
		// NSWorkspace -URLForApplicationToOpenURL: (10.10+) returns the
		// .app bundle URL of the default handler.
		appURL := send(workspace(), "URLForApplicationToOpenURL:", uintptr(u))
		if appURL == 0 {
			err = fmt.Errorf("mygo: no application found for %q", url)
			return
		}
		// Pull the file-system path from the NSURL.
		path := goString(send(appURL, "path"))
		if path == "" {
			err = fmt.Errorf("mygo: no application found for %q", url)
			return
		}
		// Resolve name and bundle ID from the .app bundle.
		bundle := send(class("NSBundle"), "bundleWithPath:", uintptr(nsString(path)))
		fm := send(class("NSFileManager"), "defaultManager")
		name := strings.TrimSuffix(goString(send(fm, "displayNameAtPath:", uintptr(nsString(path)))), ".app")
		id := ""
		if bundle != 0 {
			id = goString(send(bundle, "bundleIdentifier"))
		}
		if id == "" {
			id = path
		}
		app = platform.Application{Name: name, ID: id, Path: path}
	})
	return app, err
}

// Screen (NSScreen).

type screen struct{}

func (screen) Displays() []platform.Display {
	var out []platform.Display
	withPool(func() {
		screens := arrayItems(send(class("NSScreen"), "screens"))
		if len(screens) == 0 {
			return
		}
		key := nsString("NSScreenNumber")
		for i, s := range screens {
			num := send(send(s, "deviceDescription"), "objectForKey:", uintptr(key))
			displayID := uint32(send(num, "unsignedIntValue"))
			d := platform.Display{
				ID:          int64(displayID),
				Bounds:      rectFromMac(msgRect(s, sel("frame"))),
				WorkArea:    rectFromMac(msgRect(s, sel("visibleFrame"))),
				ScaleFactor: msgFloat(s, sel("backingScaleFactor")),
				Rotation:    int(math.Round(cgDisplayRotation(displayID))),
				Internal:    cgDisplayIsBuiltin(displayID),
				Primary:     i == 0,
			}
			if respondsTo(s, "localizedName") {
				d.Label = goString(send(s, "localizedName"))
			}
			out = append(out, d)
		}
	})
	return out
}

func (screen) CursorPoint() platform.Point {
	p := msgPoint(class("NSEvent"), sel("mouseLocation"))
	return platform.Point{X: int(math.Round(p.X)), Y: int(math.Round(primaryScreenHeight() - p.Y))}
}

// Theme (NSAppearance).

type theme struct{ b *Backend }

// UIFont is Core Text's to find: the system font.
func (theme) UIFont() string { return "" }

func (theme) FontRendering() platform.FontRendering { return platform.FontRendering{} }

// Preferences reads the accent color and the display settings of
// accessibility.
func (t theme) Preferences() platform.Preferences {
	var p platform.Preferences
	withPool(func() {
		ws := workspace()
		p.ReduceMotion = sendBool(ws, "accessibilityDisplayShouldReduceMotion")
		p.ReduceTransparency = sendBool(ws, "accessibilityDisplayShouldReduceTransparency")
		p.HighContrast = sendBool(ws, "accessibilityDisplayShouldIncreaseContrast")
		// The accent, as the app's appearance draws it.
		var c id
		appearance := class("NSAppearance")
		prev := send(appearance, "currentAppearance")
		send(appearance, "setCurrentAppearance:", uintptr(send(t.b.app, "effectiveAppearance")))
		if accent := send(class("NSColor"), "controlAccentColor"); accent != 0 {
			c = send(accent, "colorUsingColorSpace:", uintptr(send(class("NSColorSpace"), "sRGBColorSpace")))
		}
		send(appearance, "setCurrentAppearance:", uintptr(prev))
		if c != 0 {
			var r, g, b, a float64
			send(c, "getRed:green:blue:alpha:", uintptr(unsafe.Pointer(&r)), uintptr(unsafe.Pointer(&g)), uintptr(unsafe.Pointer(&b)), uintptr(unsafe.Pointer(&a)))
			byteOf := func(v float64) uint8 { return uint8(max(0, min(v, 1))*255 + 0.5) }
			p.Accent = platform.Color{R: byteOf(r), G: byteOf(g), B: byteOf(b), A: 255}
		}
	})
	return p
}

func (t theme) IsDark() bool {
	var dark bool
	withPool(func() {
		appearance := send(t.b.app, "effectiveAppearance")
		names := nsArray(nsString("NSAppearanceNameAqua"), nsString("NSAppearanceNameDarkAqua"))
		dark = goString(send(appearance, "bestMatchFromAppearancesWithNames:", uintptr(names))) == "NSAppearanceNameDarkAqua"
	})
	return dark
}

func (t theme) SetSource(source string) {
	withPool(func() {
		var appearance id
		switch source {
		case "light":
			appearance = send(class("NSAppearance"), "appearanceNamed:", uintptr(nsString("NSAppearanceNameAqua")))
		case "dark":
			appearance = send(class("NSAppearance"), "appearanceNamed:", uintptr(nsString("NSAppearanceNameDarkAqua")))
		}
		send(t.b.app, "setAppearance:", uintptr(appearance))
	})
}
