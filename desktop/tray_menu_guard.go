package main

import "errors"

// Recovering a hidden or locked application must not depend on renderer freshness.
func trayMenuCommandCurrent(captured, current trayMenuState, command trayMenuCommand) bool {
	switch command {
	case trayShowMain, trayQuit, trayUnlockLyrics:
		return true
	default:
		// A palette change rebuilds the menu without changing its command owner.
		captured.icons = current.icons
		return current.ready && captured == current
	}
}

func trayRequestForCommand(session *traySession, captured TrayPlaybackState, command trayMenuCommand) (TrayRequest, error) {
	var action TrayAction
	var mode *TrayPlayMode
	switch command {
	case trayPrevious:
		action = TrayPrevious
	case trayToggle:
		action = TrayToggle
	case trayNext:
		action = TrayNext
	case traySettings:
		action = TrayOpenSettings
	case trayFavorite:
		action = TrayFavorite
	case trayModeRepeat, trayModeRepeatOnce, trayModeShuffle:
		action = TraySetPlayMode
		target := TrayModeRepeat
		if command == trayModeRepeatOnce {
			target = TrayModeRepeatOnce
		} else if command == trayModeShuffle {
			target = TrayModeShuffle
		}
		mode = &target
	default:
		return TrayRequest{}, errors.New("tray command has no renderer request")
	}
	return session.request(captured, action, mode)
}
