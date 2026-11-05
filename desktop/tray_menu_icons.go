package main

import (
	"log"

	"github.com/egoist/mygo"

	desktopassets "github.com/he-music/HE-Music"
)

// Template menus tint their icons and render disabled states natively. Linux
// panels receive PNG data instead, so use the existing themed artwork there.
type trayMenuIconStyle struct {
	template bool
	dark     bool
}

func trayMenuIconStyleForPlatform(platform string, dark bool) trayMenuIconStyle {
	if platform == "linux" {
		return trayMenuIconStyle{dark: dark}
	}
	return trayMenuIconStyle{template: true}
}

type trayMenuIcons map[string]*mygo.MenuIcon

func (icons *trayMenuIcons) get(name string, disabled bool) *mygo.MenuIcon {
	if icons == nil {
		return nil
	}
	if disabled {
		name += "-disabled"
	}
	return (*icons)[name]
}

// The lifecycle owns this cache on the main thread. Keep each icon alive across
// menu rebuilds; the SDK also caches its decoded native image for these handles.
type trayMenuIconCache struct {
	styles map[trayMenuIconStyle]*trayMenuIcons
}

func (cache *trayMenuIconCache) get(style trayMenuIconStyle) *trayMenuIcons {
	if icons := cache.styles[style]; icons != nil {
		return icons
	}
	icons := make(trayMenuIcons)
	for _, name := range []string{
		"music", "prev", "play", "pause", "next", "like", "unlike",
		"repeat", "repeat-once", "shuffle", "lyric", "lock", "unlock", "setting", "power",
	} {
		for _, disabled := range []bool{false, true} {
			key := name
			if disabled {
				key += "-disabled"
			}
			if style.template && disabled {
				icons[key] = icons[name]
				continue
			}
			variant := "-light"
			if style.dark {
				variant = "-dark"
			}
			filename := name + variant
			if disabled {
				filename += "-disabled"
			}
			data, err := desktopassets.TrayMenu.ReadFile("public/icons/tray/" + filename + ".png")
			if err == nil {
				icons[key], err = mygo.NewMenuIcon(data, style.template)
			}
			if err != nil {
				// Missing artwork must not remove native recovery commands. Cache
				// the result as well, so later menu updates do not retry or spam logs.
				log.Printf("desktop tray menu icon %s unavailable: %v", filename, err)
			}
		}
	}
	if cache.styles == nil {
		cache.styles = make(map[trayMenuIconStyle]*trayMenuIcons)
	}
	cache.styles[style] = &icons
	return &icons
}
