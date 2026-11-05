package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestTrayMenuArtworkAndCache(t *testing.T) {
	var cache trayMenuIconCache
	for _, platform := range []string{"darwin", "windows", "linux"} {
		for _, dark := range []bool{false, true} {
			style := trayMenuIconStyleForPlatform(platform, dark)
			icons := cache.get(style)
			if icons != cache.get(style) {
				t.Fatal("menu rebuild discarded cached artwork")
			}
			if len(*icons) != 30 {
				t.Fatalf("%s dark=%v: incomplete icon catalog", platform, dark)
			}
			for name, icon := range *icons {
				if icon == nil {
					t.Fatalf("%s dark=%v: missing embedded artwork %q", platform, dark, name)
				}
			}
			if platform != "linux" {
				if !style.template || icons.get("play", true) != icons.get("play", false) ||
					icons != cache.get(trayMenuIconStyleForPlatform(platform, !dark)) {
					t.Fatal("native template menus need one stable icon across theme and disabled changes")
				}
			} else if style.template || style.dark != dark || icons.get("play", true) == icons.get("play", false) {
				t.Fatal("Linux must export the themed and disabled artwork")
			}
		}
	}
	light := cache.get(trayMenuIconStyleForPlatform("linux", false))
	dark := cache.get(trayMenuIconStyleForPlatform("linux", true))
	if light == dark || light.get("play", false) == dark.get("play", false) {
		t.Fatal("Linux theme change retained the old image")
	}
	if light != cache.get(trayMenuIconStyleForPlatform("linux", false)) {
		t.Fatal("switching back to the light theme reloaded its artwork")
	}
}

func TestTrayMenuIconsFollowPlaybackAndRecovery(t *testing.T) {
	var cache trayMenuIconCache
	// Linux has separate disabled artwork, so this also checks that icon state
	// agrees with native enabled state rather than just the playback boolean.
	icons := cache.get(trayMenuIconStyleForPlatform("linux", false))
	find := func(items []*mygo.MenuItem, label string) *mygo.MenuItem {
		t.Helper()
		for _, item := range items {
			if item.Label == label {
				return item
			}
		}
		t.Fatalf("missing tray item %q", label)
		return nil
	}
	for _, playing := range []bool{false, true} {
		for _, liked := range []bool{false, true} {
			for _, mode := range []TrayPlayMode{TrayModeRepeat, TrayModeRepeatOnce, TrayModeShuffle} {
				state := trayMenuState{
					ready: true, hasSong: true, playing: playing, canHide: true,
					lyricsAvailable: true, lyricsVisible: true, icons: icons,
					playback: TrayPlaybackState{
						HasSong: true, Playing: playing, Liked: liked,
						CanFavorite: true, CanSetMode: true, PlayMode: mode,
					},
				}
				items := buildTrayMenuItems(state, nil)
				assertTrayMenuItemIcons(t, items, icons)
				playLabel, playIcon := "播放", "play"
				if playing {
					playLabel, playIcon = "暂停", "pause"
				}
				if find(items, playLabel).Icon != icons.get(playIcon, false) {
					t.Fatal("play/pause icon does not follow playback")
				}
				favoriteLabel, favoriteIcon := "添加到收藏", "unlike"
				if liked {
					favoriteLabel, favoriteIcon = "取消收藏", "like"
				}
				if find(items, favoriteLabel).Icon != icons.get(favoriteIcon, false) {
					t.Fatal("favorite icon does not follow the current song")
				}
			}
		}
	}

	state := trayMenuState{icons: icons}
	items := buildTrayMenuItems(state, nil)
	for label, icon := range map[string]string{
		"隐藏主窗口": "music", "上一首": "prev", "播放": "play", "下一首": "next",
		"添加到收藏": "unlike", "列表循环": "repeat", "显示桌面歌词": "lyric",
		"锁定桌面歌词": "unlock", "设置": "setting",
	} {
		item := find(items, label)
		if !item.Disabled || item.Icon != icons.get(icon, true) {
			t.Fatalf("%q has the wrong disabled icon", label)
		}
	}
	for label, icon := range map[string]string{"显示主窗口": "music", "退出": "power"} {
		item := find(items, label)
		if item.Disabled || item.Icon != icons.get(icon, false) {
			t.Fatalf("%q lost its native recovery action", label)
		}
	}
	// An already locked lyric can be unlocked even after renderer revocation.
	state.lyricsLocked = true
	unlock := find(buildTrayMenuItems(state, nil), "解锁桌面歌词")
	if unlock.Disabled || unlock.Icon != icons.get("lock", false) {
		t.Fatal("locked lyric recovery has the wrong icon or disabled state")
	}
}

func assertTrayMenuItemIcons(t *testing.T, items []*mygo.MenuItem, icons *trayMenuIcons) {
	t.Helper()
	for _, item := range items {
		if item.Type != mygo.MenuItemSeparator && item.Icon == nil {
			t.Fatalf("missing icon on %q", item.Label)
		}
		for _, child := range item.Submenu {
			if child.Icon == nil || child.Icon != icons.get(string(trayModeForMenuLabel(child.Label)), false) {
				t.Fatalf("wrong playback mode icon on %q", child.Label)
			}
			if child.Checked && item.Icon != child.Icon {
				t.Fatal("playback mode menu icon does not match its selection")
			}
		}
	}
}

func TestTrayMenuThemeChangeKeepsCommandOwner(t *testing.T) {
	light, dark := trayMenuIcons{}, trayMenuIcons{}
	captured := trayMenuState{
		ready: true, icons: &light,
		playback: TrayPlaybackState{Epoch: 1, Revision: 1, TrackKey: "song"},
	}
	current := captured
	current.icons = &dark
	if captured == current {
		t.Fatal("theme change must refresh the native menu")
	}
	if !trayMenuCommandCurrent(captured, current, trayToggle) {
		t.Fatal("changing only the icon palette dropped a current command")
	}
	current.playback.Revision++
	if trayMenuCommandCurrent(captured, current, trayToggle) {
		t.Fatal("theme handling bypassed playback freshness")
	}
}

func trayModeForMenuLabel(label string) TrayPlayMode {
	return map[string]TrayPlayMode{"列表循环": TrayModeRepeat, "单曲循环": TrayModeRepeatOnce, "随机播放": TrayModeShuffle}[label]
}
