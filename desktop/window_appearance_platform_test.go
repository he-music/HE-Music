package main

import (
	"runtime"
	"testing"

	"github.com/egoist/mygo"
)

func TestWindowAppearancePlatformChrome(t *testing.T) {
	for _, borderless := range []bool{false, true} {
		options := WindowAppearanceOptions(WindowAppearance{UseBorderless: borderless})
		if runtime.GOOS == "darwin" && borderless {
			if options.Frameless || options.TitleBarStyle != mygo.TitleBarHidden || options.HideWindowButtons {
				t.Fatalf("macOS borderless must keep native controls: %#v", options)
			}
			if options.TrafficLightPosition == nil || *options.TrafficLightPosition != (mygo.Point{X: 16, Y: 28}) {
				t.Fatalf("macOS traffic lights lost their original placement: %#v", options.TrafficLightPosition)
			}
		} else if options.Frameless != borderless || options.TitleBarStyle != "" || options.TrafficLightPosition != nil {
			t.Fatalf("ordinary frame mapping changed: %#v", options)
		}
	}
}
