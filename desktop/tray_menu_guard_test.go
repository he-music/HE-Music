package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestTrayMenuCapturedStateAndRecovery(t *testing.T) {
	var session traySession
	epoch, err := session.begin()
	if err != nil {
		t.Fatal(err)
	}
	playback := TrayPlaybackState{
		Epoch: epoch, Revision: 1, TrackKey: "A", HasSong: true,
		CanFavorite: true, CanSetMode: true, Liked: true, PlayMode: TrayModeRepeat,
	}
	if err := session.sync(playback); err != nil {
		t.Fatal(err)
	}
	captured := trayMenuState{
		playback: playback, ready: true, hasSong: true,
		lyricsAvailable: true, lyricsVisible: true, lyricsLocked: true, canHide: true,
	}
	current := captured
	var requests []TrayRequest
	var recovery []trayMenuCommand
	items := buildTrayMenuItems(captured, func(command trayMenuCommand) {
		if !trayMenuCommandCurrent(captured, current, command) {
			return
		}
		switch command {
		case trayShowMain, trayQuit, trayUnlockLyrics:
			recovery = append(recovery, command)
		default:
			request, err := trayRequestForCommand(&session, captured.playback, command)
			if err == nil {
				requests = append(requests, request)
			}
		}
	})
	find := func(label string) *mygo.MenuItem {
		for _, item := range items {
			if item.Label == label {
				return item
			}
		}
		t.Fatalf("missing menu %q", label)
		return nil
	}
	find("取消收藏").Click(nil, nil)
	find("列表循环").Submenu[2].Click(nil, nil)
	if len(requests) != 2 || requests[0].Favorite == nil || *requests[0].Favorite ||
		requests[1].Mode == nil || *requests[1].Mode != TrayModeShuffle {
		t.Fatalf("wrong typed requests: %+v", requests)
	}
	// A native visibility/lock change invalidates the closure even without a new playback revision.
	current.lyricsVisible = false
	find("设置").Click(nil, nil)
	find("下一首").Click(nil, nil)
	if len(requests) != 2 {
		t.Fatal("old menu survived a native state change")
	}
	current = captured
	for _, track := range []string{"B", "A"} {
		playback.Revision++
		playback.TrackKey = track
		if err := session.sync(playback); err != nil {
			t.Fatal(err)
		}
	}
	current.playback = session.snapshot()
	find("取消收藏").Click(nil, nil)
	find("列表循环").Submenu[1].Click(nil, nil)
	if len(requests) != 2 {
		t.Fatal("old menu survived A -> B -> A")
	}
	session.revoke()
	current = trayMenuState{}
	find("显示主窗口").Click(nil, nil)
	find("退出").Click(nil, nil)
	find("解锁桌面歌词").Click(nil, nil)
	if len(recovery) != 3 {
		t.Fatal("recovery commands require a live renderer")
	}
}

func TestTrayMenuCommandMapping(t *testing.T) {
	var session traySession
	epoch, err := session.begin()
	if err != nil {
		t.Fatal(err)
	}
	state := TrayPlaybackState{
		Epoch: epoch, Revision: 1, TrackKey: "track", HasSong: true,
		CanFavorite: true, CanSetMode: true, PlayMode: TrayModeRepeat,
	}
	if err := session.sync(state); err != nil {
		t.Fatal(err)
	}
	for command, action := range map[trayMenuCommand]TrayAction{
		trayPrevious: TrayPrevious, trayNext: TrayNext, trayToggle: TrayToggle,
		traySettings: TrayOpenSettings, trayFavorite: TrayFavorite,
		trayModeRepeat: TraySetPlayMode, trayModeRepeatOnce: TraySetPlayMode, trayModeShuffle: TraySetPlayMode,
	} {
		request, err := trayRequestForCommand(&session, state, command)
		if err != nil || request.Action != action || request.TrackKey != state.TrackKey {
			t.Fatalf("command %v: %+v %v", command, request, err)
		}
	}
	if _, err := trayRequestForCommand(&session, state, trayQuit); err == nil {
		t.Fatal("quit became a renderer action")
	}
}
