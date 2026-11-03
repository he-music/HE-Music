package desktopassets

import "embed"

// Tray icons are embedded from the existing Electron assets so packaged apps
// never depend on the working directory or an external Node resource loader.
//
//go:embed public/icons/tray/trayTemplate.png
var TrayTemplate []byte

//go:embed public/icons/tray/tray.png
var TrayColor []byte

// Menu artwork is shared with Electron and loaded lazily by the native tray.
//
//go:embed public/icons/tray/*-light.png public/icons/tray/*-dark.png public/icons/tray/*-light-disabled.png public/icons/tray/*-dark-disabled.png
var TrayMenu embed.FS
