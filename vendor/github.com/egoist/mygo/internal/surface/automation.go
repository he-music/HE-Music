package surface

import "github.com/egoist/mygo/internal/platform"

// Automated is what the content of a window tells plugins/automation,
// which drives apps from another process. Package ui implements it. Its
// methods run on the main thread.
type Automated interface {
	// AutomationTree returns the elements of the last frame as assistive
	// technology reads them, in the window's DIPs, and the keys the app
	// gave elements (ui's Key), by element ID.
	AutomationTree() (tree *platform.AccessTree, keys map[uint64]any)
	// FramePending reports whether the content asked for a frame that has
	// not come yet, as it does after input and while something animates;
	// in a window none of which shows, a frame that waits to be built.
	FramePending() bool
	// Settle builds at once the frame the content waits to build, if one
	// waits, in a window none of which shows, whose surface may draw no
	// frame until it shows (on macOS a hidden window's, or any while the
	// screen is locked): the view then takes the input the plugin gave it,
	// as a press, and the tree and captures are of what it shows now.
	Settle()
}

// Automate is set by plugins/automation, in an app that links it and
// whose MYGO_AUTOMATION asks for it, before any window opens. Package ui
// then calls it on the main thread with the connection and the content of
// each window of native UI as the content attaches. Apps that don't link
// the plugin leave it nil and link none of Automated's methods, which
// only the plugin calls.
var Automate func(conn *Conn, content Automated)
