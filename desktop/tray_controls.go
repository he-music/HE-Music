package main

import "github.com/egoist/mygo"

// Build templates only. Dispatch belongs to the owner of the main Page, never
// to the focused window supplied by the SDK callback.
func buildTrayPlaybackControls(playback TrayPlaybackState, ready bool, labels LifecycleLabels, dispatch func(trayMenuCommand)) []*mygo.MenuItem {
	label := func(value, fallback string) string {
		if value != "" {
			return value
		}
		return fallback
	}
	favoriteLabel := label(labels.AddToFavorites, "添加到收藏")
	if playback.Liked {
		favoriteLabel = label(labels.RemoveFromFavorites, "取消收藏")
	}
	favoriteEnabled := ready && playback.HasSong && playback.CanFavorite
	modeEnabled := ready && playback.HasSong && playback.CanSetMode
	favorite := &mygo.MenuItem{Type: mygo.MenuItemNormal, Label: favoriteLabel, Disabled: !favoriteEnabled}
	favorite.Click = func(*mygo.MenuItem, *mygo.Window) {
		if favoriteEnabled && dispatch != nil {
			dispatch(trayFavorite)
		}
	}
	choices := []struct {
		mode    TrayPlayMode
		label   string
		command trayMenuCommand
	}{
		{TrayModeRepeat, label(labels.Repeat, "列表循环"), trayModeRepeat},
		{TrayModeRepeatOnce, label(labels.RepeatOnce, "单曲循环"), trayModeRepeatOnce},
		{TrayModeShuffle, label(labels.Shuffle, "随机播放"), trayModeShuffle},
	}
	// Unsynced zero values still render one deterministic native selection.
	authoritative := playback.PlayMode
	if !validTrayMode(authoritative) {
		authoritative = TrayModeRepeat
	}
	mode := &mygo.MenuItem{Type: mygo.MenuItemSubmenu, Disabled: !modeEnabled}
	for _, choice := range choices {
		item := &mygo.MenuItem{Type: mygo.MenuItemRadio, Label: choice.label, Disabled: !modeEnabled, Checked: choice.mode == authoritative}
		if item.Checked {
			mode.Label = choice.label
		}
		mode.Submenu = append(mode.Submenu, item)
	}
	for index, choice := range choices {
		mode.Submenu[index].Click = func(*mygo.MenuItem, *mygo.Window) {
			// The SDK changes radio state before Click. Restore every captured item
			// before dispatch, even when the action is rejected or targets this mode.
			for i, item := range mode.Submenu {
				item.SetChecked(choices[i].mode == authoritative)
			}
			if modeEnabled && dispatch != nil {
				dispatch(choice.command)
			}
		}
	}
	return []*mygo.MenuItem{favorite, mode}
}
