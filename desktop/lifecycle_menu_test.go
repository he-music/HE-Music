package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestLifecycleMenuStateAndNativeRecovery(t *testing.T) {
	for bits := range 256 {
		s := trayMenuState{
			ready: bits&1 != 0, hasSong: bits&2 != 0, playing: bits&4 != 0,
			canHide: bits&8 != 0, lyricsAvailable: bits&16 != 0,
			lyricsVisible: bits&32 != 0, lyricsPending: bits&64 != 0, lyricsLocked: bits&128 != 0,
		}
		commands := []trayMenuCommand{}
		items := buildTrayMenuItems(s, func(command trayMenuCommand) { commands = append(commands, command) })
		playLabel := "播放"
		if s.playing {
			playLabel = "暂停"
		}
		lyricsLabel, lyricsCommand := "显示桌面歌词", trayShowLyrics
		if s.lyricsVisible || s.lyricsPending {
			lyricsLabel, lyricsCommand = "隐藏桌面歌词", trayHideLyrics
		}
		lockLabel, lockCommand := "锁定桌面歌词", trayLockLyrics
		if s.lyricsLocked {
			lockLabel, lockCommand = "解锁桌面歌词", trayUnlockLyrics
		}
		for _, want := range []struct {
			label   string
			enabled bool
			command trayMenuCommand
		}{
			{"显示主窗口", true, trayShowMain},
			{"隐藏主窗口", s.canHide, trayHideMain},
			{"上一首", s.ready && s.hasSong, trayPrevious},
			{playLabel, s.ready && s.hasSong, trayToggle},
			{"下一首", s.ready && s.hasSong, trayNext},
			{lyricsLabel, s.lyricsAvailable, lyricsCommand},
			{lockLabel, s.lyricsLocked || (s.lyricsAvailable && s.lyricsVisible && !s.lyricsPending && s.canHide), lockCommand},
			{"设置", s.ready, traySettings},
			{"退出", true, trayQuit},
		} {
			var found *mygo.MenuItem
			for _, item := range items {
				if item.Label == want.label {
					if found != nil {
						t.Fatalf("state=%d duplicate item %q", bits, want.label)
					}
					found = item
				}
			}
			requireTestNotEqual(t, found, nil)
			requireTestEqual(t, found.Disabled, !want.enabled)
			if found.Click == nil {
				t.Fatalf("state=%d missing action for %q", bits, want.label)
			}
			if want.enabled {
				before := len(commands)
				// Focused child identity must not change the native command mapping.
				found.Click(found, &mygo.Window{})
				requireTestEqual(t, len(commands), before+1)
				requireTestEqual(t, commands[before], want.command)
			}
		}
	}
}

func TestLifecycleMenuLocalizedLabels(t *testing.T) {
	labels := LifecycleLabels{
		Show: "show", Hide: "hide", Play: "play", Pause: "pause", Previous: "previous", Next: "next",
		ShowLyrics: "show lyrics", HideLyrics: "hide lyrics", LockLyrics: "lock lyrics", UnlockLyrics: "unlock lyrics",
		Settings: "settings", Quit: "quit",
	}
	for _, locked := range []bool{false, true} {
		items := buildTrayMenuItems(trayMenuState{labels: labels, lyricsVisible: locked, lyricsLocked: locked, playing: locked}, nil)
		seen := map[string]bool{}
		for _, item := range items {
			if item.Label != "" {
				seen[item.Label] = true
			}
		}
		want := []string{"show", "hide", "previous", "next", "settings", "quit"}
		if locked {
			want = append(want, "pause", "hide lyrics", "unlock lyrics")
		} else {
			want = append(want, "play", "show lyrics", "lock lyrics")
		}
		for _, label := range want {
			if !seen[label] {
				t.Fatalf("missing localized label %q", label)
			}
		}
	}
}
