//go:build windows && (amd64 || arm64)

package windows

import (
	"testing"

	"github.com/egoist/mygo/internal/platform"
)

// This test is overlaid into the vendored SDK package by the test-windows
// command, so it checks the actual message dispatch without changing vendor.
func TestTransparentOverlayKeepsNativeFramePaintingDisabled(t *testing.T) {
	for _, test := range []struct {
		name        string
		transparent bool
		frameless   bool
		shadow      bool
		surface     bool
		handled     bool
	}{
		{"lyrics overlay", true, true, false, false, true},
		{"opaque main window", false, true, false, false, false},
		{"normal frame", true, false, false, false, false},
		{"requested shadow", true, true, true, false, false},
		{"native UI", true, true, false, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := &window{
				b: New(), opts: &platform.WindowOptions{Transparent: test.transparent, Surface: test.surface},
				frameless: test.frameless, shadow: test.shadow,
				minW: 640, minH: 140, maxW: 1400, maxH: 360,
			}
			for _, message := range []struct {
				id   uint32
				want uintptr
			}{{wmNCPaint, 0}, {wmNCActivate, 1}} {
				result, handled := w.message(message.id, 0, 0)
				if handled != test.handled || handled && result != message.want {
					t.Fatalf("message %#x: result=%d handled=%v", message.id, result, handled)
				}
			}
			if w.minW != 640 || w.minH != 140 || w.maxW != 1400 || w.maxH != 360 {
				t.Fatal("frame painting changed the sizing constraints")
			}
		})
	}
}
