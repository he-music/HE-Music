package main

import (
	"bytes"
	"image/png"
	"testing"
)

func TestLifecycleTemplateIconVisibleBlackAndTransparent(t *testing.T) {
	data := desktopTrayTemplateIcon()
	icon, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if icon.Bounds().Dx() != 36 || icon.Bounds().Dy() != 36 {
		t.Fatalf("unexpected template dimensions: %v", icon.Bounds())
	}
	visible, transparent := 0, 0
	for y := range 36 {
		for x := range 36 {
			r, g, b, a := icon.At(x, y).RGBA()
			if a == 0 {
				transparent++
				continue
			}
			visible++
			if r != 0 || g != 0 || b != 0 || a != 65535 {
				t.Fatalf("template pixel (%d,%d) must be opaque black", x, y)
			}
		}
	}
	if visible < 150 || transparent < 500 {
		t.Fatalf("template is not a visible silhouette: visible=%d transparent=%d", visible, transparent)
	}
	if !bytes.Equal(data, desktopTrayTemplateIcon()) {
		t.Fatal("template generation must be deterministic")
	}
}
