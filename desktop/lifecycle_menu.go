package main

import "github.com/egoist/mygo"

type trayMenuCommand uint8

const (
	trayShowMain trayMenuCommand = iota
	trayHideMain
	trayPrevious
	trayToggle
	trayNext
	trayShowLyrics
	trayHideLyrics
	trayLockLyrics
	trayUnlockLyrics
	traySettings
	trayQuit
	trayFavorite
	trayModeRepeat
	trayModeRepeatOnce
	trayModeShuffle
)

type trayMenuState struct {
	playback        TrayPlaybackState
	labels          LifecycleLabels
	ready           bool
	hasSong         bool
	playing         bool
	canHide         bool
	lyricsAvailable bool
	lyricsVisible   bool
	lyricsPending   bool
	lyricsLocked    bool
	icons           *trayMenuIcons
}

// This constructs data only: focused windows and native resources are not consulted.
func buildTrayMenuItems(state trayMenuState, dispatch func(trayMenuCommand)) []*mygo.MenuItem {
	label := func(value, fallback string) string {
		if value == "" {
			return fallback
		}
		return value
	}
	click := func(command trayMenuCommand) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) {
			if dispatch != nil {
				dispatch(command)
			}
		}
	}
	labels := state.labels
	playingLabel, playingIcon := label(labels.Play, "播放"), "play"
	if state.playing {
		playingLabel, playingIcon = label(labels.Pause, "暂停"), "pause"
	}
	lyricsLabel, lyricsCommand := label(labels.ShowLyrics, "显示桌面歌词"), trayShowLyrics
	if state.lyricsVisible || state.lyricsPending {
		lyricsLabel, lyricsCommand = label(labels.HideLyrics, "隐藏桌面歌词"), trayHideLyrics
	}
	lockLabel, lockCommand, lockIcon := label(labels.LockLyrics, "锁定桌面歌词"), trayLockLyrics, "unlock"
	if state.lyricsLocked {
		lockLabel, lockCommand, lockIcon = label(labels.UnlockLyrics, "解锁桌面歌词"), trayUnlockLyrics, "lock"
	}
	playbackEnabled := state.ready && state.hasSong
	lockDisabled := !state.lyricsLocked && (!state.lyricsAvailable || !state.lyricsVisible || state.lyricsPending || !state.canHide)
	controls := buildTrayPlaybackControls(state.playback, state.ready, state.labels, state.icons, dispatch)
	return []*mygo.MenuItem{
		{Label: label(labels.Show, "显示主窗口"), Icon: state.icons.get("music", false), Click: click(trayShowMain)},
		{Label: label(labels.Hide, "隐藏主窗口"), Disabled: !state.canHide, Icon: state.icons.get("music", !state.canHide), Click: click(trayHideMain)},
		mygo.Separator(),
		{Label: label(labels.Previous, "上一首"), Disabled: !playbackEnabled, Icon: state.icons.get("prev", !playbackEnabled), Click: click(trayPrevious)},
		{Label: playingLabel, Disabled: !playbackEnabled, Icon: state.icons.get(playingIcon, !playbackEnabled), Click: click(trayToggle)},
		{Label: label(labels.Next, "下一首"), Disabled: !playbackEnabled, Icon: state.icons.get("next", !playbackEnabled), Click: click(trayNext)},
		controls[0],
		controls[1],
		mygo.Separator(),
		{Label: lyricsLabel, Disabled: !state.lyricsAvailable, Icon: state.icons.get("lyric", !state.lyricsAvailable), Click: click(lyricsCommand)},
		{Label: lockLabel, Disabled: lockDisabled, Icon: state.icons.get(lockIcon, lockDisabled), Click: click(lockCommand)},
		{Label: label(labels.Settings, "设置"), Disabled: !state.ready, Icon: state.icons.get("setting", !state.ready), Click: click(traySettings)},
		mygo.Separator(),
		{Label: label(labels.Quit, "退出"), Icon: state.icons.get("power", false), Click: click(trayQuit)},
	}
}

func (l *DesktopLifecycle) lyricsReady() bool {
	return l.state.ready() && l.main != nil && !l.main.IsDestroyed() &&
		desktopLyrics.main == l.main && l.state.owns(desktopLyrics.state.owner)
}

func (l *DesktopLifecycle) dispatchTrayCommand(command trayMenuCommand, captured TrayPlaybackState) {
	// Unlock remains a native recovery action even while renderer revocation is queued.
	switch command {
	case trayShowMain:
		l.show()
		return
	case trayQuit:
		l.quit()
		return
	case trayUnlockLyrics:
		_ = desktopLyrics.setLocked(false)
		return
	}
	if !l.state.ready() || l.main == nil || l.main.IsDestroyed() || !l.traySession.matches(captured) {
		return
	}
	switch command {
	case trayHideMain:
		_ = l.hide()
	case trayPrevious, trayToggle, trayNext, trayFavorite, trayModeRepeat, trayModeRepeatOnce, trayModeShuffle, traySettings:
		request, err := trayRequestForCommand(&l.traySession, captured, command)
		if err != nil {
			return
		}
		if command == traySettings {
			l.show()
		}
		_ = desktopTrayAction.EmitPage(l.main.Page(), request)
	case trayShowLyrics:
		if l.lyricsReady() && desktopLyrics.win == nil {
			_ = desktopLyrics.createWindow()
		}
	case trayHideLyrics:
		if l.lyricsReady() {
			desktopLyrics.closeWindow(desktopLyrics.state.generation, "")
		}
	case trayLockLyrics:
		if l.lyricsReady() {
			_ = desktopLyrics.setLocked(true)
		}
	}
}
