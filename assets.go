package desktopassets

import _ "embed"

// Tray icons are embedded from the existing Electron assets so packaged apps
// never depend on the working directory or an external Node resource loader.
//
//go:embed public/icons/tray/trayTemplate.png
var TrayTemplate []byte

//go:embed public/icons/tray/tray.png
var TrayColor []byte
