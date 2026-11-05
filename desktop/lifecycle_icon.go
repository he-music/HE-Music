package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
)

// macOS scales this black-and-transparent template to 18 points in the menu bar.
func desktopTrayTemplateIcon() []byte {
	icon := image.NewNRGBA(image.Rect(0, 0, 36, 36))
	ink := color.NRGBA{A: 255}
	for y := range 36 {
		for x := range 36 {
			leftStem := x >= 13 && x < 17 && y >= 9 && y <= 26
			rightStem := x >= 27 && x < 31 && y >= 5 && y <= 22
			beam := x >= 13 && x < 31 && y >= 8-(x-13)/4 && y < 13-(x-13)/4
			leftHead := (x-10)*(x-10)*9+(y-27)*(y-27)*25 <= 225
			rightHead := (x-24)*(x-24)*9+(y-23)*(y-23)*25 <= 225
			if leftStem || rightStem || beam || leftHead || rightHead {
				icon.SetNRGBA(x, y, ink)
			}
		}
	}
	var encoded bytes.Buffer
	// Encoding an in-memory NRGBA to bytes.Buffer cannot fail.
	if err := png.Encode(&encoded, icon); err != nil {
		panic(err)
	}
	return encoded.Bytes()
}
