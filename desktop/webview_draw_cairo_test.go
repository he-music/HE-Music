//go:build darwin || linux

package main

import (
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebitengine/purego"
)

// 使用真实 Cairo image surface 检查像素，不依赖 Linux 图形会话。
// GTK 的 WebView 拥有自己的 GdkWindow，父控件的清理不能替代子控件清理。
func TestLyricsWebViewDrawClearsItsOwnSurface(t *testing.T) {
	var library uintptr
	for _, name := range []string{"libcairo.so.2", "/opt/homebrew/lib/libcairo.2.dylib", "/usr/local/lib/libcairo.2.dylib"} {
		if handle, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_LOCAL); err == nil {
			library = handle
			break
		}
	}
	if library == 0 {
		t.Skip("Cairo image test library is unavailable")
	}
	t.Cleanup(func() { _ = purego.Dlclose(library) })
	var createSurface func(int32, int32, int32) uintptr
	var surfaceStatus func(uintptr) int32
	var destroySurface func(uintptr)
	var createContext func(uintptr) uintptr
	var destroyContext func(uintptr)
	var sourceRGBA func(uintptr, float64, float64, float64, float64)
	var rectangle func(uintptr, float64, float64, float64, float64)
	var fill, clip func(uintptr)
	var writePNG func(uintptr, string) int32
	var draw nativeTransparentDrawAccess
	purego.RegisterLibFunc(&createSurface, library, "cairo_image_surface_create")
	purego.RegisterLibFunc(&surfaceStatus, library, "cairo_surface_status")
	purego.RegisterLibFunc(&destroySurface, library, "cairo_surface_destroy")
	purego.RegisterLibFunc(&createContext, library, "cairo_create")
	purego.RegisterLibFunc(&destroyContext, library, "cairo_destroy")
	purego.RegisterLibFunc(&sourceRGBA, library, "cairo_set_source_rgba")
	purego.RegisterLibFunc(&rectangle, library, "cairo_rectangle")
	purego.RegisterLibFunc(&fill, library, "cairo_fill")
	purego.RegisterLibFunc(&clip, library, "cairo_clip")
	purego.RegisterLibFunc(&writePNG, library, "cairo_surface_write_to_png")
	purego.RegisterLibFunc(&draw.save, library, "cairo_save")
	purego.RegisterLibFunc(&draw.setOperator, library, "cairo_set_operator")
	purego.RegisterLibFunc(&draw.paint, library, "cairo_paint")
	purego.RegisterLibFunc(&draw.restore, library, "cairo_restore")
	imageSurface := func() (uintptr, uintptr) {
		surface := createSurface(0, 16, 16) // CAIRO_FORMAT_ARGB32
		if surface == 0 || surfaceStatus(surface) != 0 {
			t.Fatal("could not create Cairo image surface")
		}
		context := createContext(surface)
		t.Cleanup(func() {
			destroyContext(context)
			destroySurface(surface)
		})
		return surface, context
	}
	parent, parentContext := imageSurface()
	child, childContext := imageSurface()
	paint := func(context uintptr, x, y, r, g, b, a float64) {
		sourceRGBA(context, r, g, b, a)
		rectangle(context, x, y, 4, 4)
		fill(context)
	}
	paint(parentContext, 2, 2, 0, 0, 1, 1)
	paint(childContext, 2, 2, 1, 0, 0, 1)  // 旧字形
	paint(childContext, 2, 12, 0, 0, 1, 1) // damage 区域以外保留的画面
	rectangle(childContext, 0, 0, 16, 8)
	clip(childContext)

	access, _, _ := policyFixture()
	hooks := make(map[uintptr]func())
	contexts := map[uintptr]uintptr{1: parentContext, 3: childContext}
	access.prepareTransparentBackground = func(widget uintptr) error {
		hooks[widget] = func() { clearNativeTransparentBackground(contexts[widget], draw) }
		return nil
	}
	if err := applyNativeLyricsRenderingPolicy(1, access); err != nil {
		t.Fatal(err)
	}
	// 仅触发 WebView 的 draw，不把父窗口 draw 当成子窗口已被清理的证据。
	if handler := hooks[3]; handler != nil {
		handler()
	}
	paint(childContext, 10, 2, 0, 1, 0, 0.5)

	check := func(surface uintptr, name string, x, y int) (uint32, uint32, uint32, uint32) {
		filename := filepath.Join(t.TempDir(), name+".png")
		if status := writePNG(surface, filename); status != 0 {
			t.Fatalf("Cairo PNG status: %d", status)
		}
		file, err := os.Open(filename)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		image, err := png.Decode(file)
		if err != nil {
			t.Fatal(err)
		}
		return image.At(x, y).RGBA()
	}
	if _, _, _, alpha := check(child, "old-glyph", 3, 3); alpha != 0 {
		t.Fatalf("old WebView glyph remained opaque: alpha=%d; parent-window clearing is insufficient", alpha)
	}
	if _, green, _, alpha := check(child, "new-glyph", 11, 3); alpha < 32000 || alpha > 33000 || green == 0 {
		t.Fatalf("new translucent glyph was not drawn after restoring Cairo state: green=%d alpha=%d", green, alpha)
	}
	if _, _, blue, alpha := check(child, "outside-damage", 3, 13); blue != 65535 || alpha != 65535 {
		t.Fatal("cleared pixels outside the WebView damage clip")
	}
	if _, _, blue, alpha := check(parent, "parent", 3, 3); blue != 65535 || alpha != 65535 {
		t.Fatal("WebView clearing changed its parent's surface")
	}
}
