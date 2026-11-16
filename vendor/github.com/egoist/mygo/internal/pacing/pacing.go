// Package pacing tells whether frames of native UI wait for the display.
//
// They do, unless MYGO_UNCAPPED asks otherwise: a frame that follows another
// draws at the display's next refresh, as the display link, GTK's frame
// clock or the swap chain's room says, and so every scene cheaper than a
// refresh shows the display's rate. Uncapped, as benchmarks, profilers and
// apps that want the least latency ask for, the next frame starts as soon
// as the last was presented, and the frame rate tells how much of a refresh
// a scene leaves. An idle window still draws nothing: only the frames asked
// for come sooner. The window host (package ui), the backends and the GPU
// renderers read Uncapped, each where it waits for the display; "Frame
// pacing" in docs/ui/rendering.md tells what each platform does.
package pacing

import (
	"log"
	"os"
	"runtime"
	"strings"
)

// Uncapped tells that MYGO_UNCAPPED asked frames to present without
// waiting for the display. It is read once, as the program starts; in
// browsers, whose requestAnimationFrame paces frames and nothing presents
// sooner, it stays false. Tests set it.
var Uncapped = uncapped(os.Getenv("MYGO_UNCAPPED"), runtime.GOOS)

func uncapped(v, goos string) bool {
	on := Setting(v)
	if on && goos == "js" {
		log.Print("mygo: MYGO_UNCAPPED has no effect in browsers, whose requestAnimationFrame paces frames at the display's rate")
		return false
	}
	return on
}

// Setting reports whether v, MYGO_UNCAPPED's value, asks for frames
// uncapped: 1 (or true, on, yes) does, and nothing, 0 (false, off, no) does
// not. Another value is a mistake, logged, which leaves frames paced.
func Setting(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "false", "off", "no":
		return false
	case "1", "true", "on", "yes":
		return true
	}
	log.Printf("mygo: MYGO_UNCAPPED=%q is neither 1 nor 0: frames stay paced by the display", v)
	return false
}
