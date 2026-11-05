package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func trayAssertChecked(t *testing.T, items []*mygo.MenuItem, want int) {
	t.Helper()
	count := 0
	for index, item := range items {
		if item.Checked {
			count++
		}
		if item.Checked != (index == want) {
			t.Fatalf("item %d checked=%v want index=%d", index, item.Checked, want)
		}
	}
	if count != 1 {
		t.Fatalf("checked count=%d", count)
	}
}

func TestTrayControlsCapabilityMatrix(t *testing.T) {
	modes := []TrayPlayMode{TrayModeRepeat, TrayModeRepeatOnce, TrayModeShuffle}
	for bits := range 32 {
		ready := bits&1 != 0
		p := TrayPlaybackState{HasSong: bits&2 != 0, CanFavorite: bits&4 != 0, CanSetMode: bits&8 != 0, Liked: bits&16 != 0}
		for selected, mode := range modes {
			p.PlayMode = mode
			commands := []trayMenuCommand{}
			items := buildTrayPlaybackControls(p, ready, LifecycleLabels{}, nil, func(command trayMenuCommand) { commands = append(commands, command) })
			requireTestEqual(t, len(items), 2)
			requireTestEqual(t, items[0].Type, mygo.MenuItemNormal)
			requireTestEqual(t, items[1].Type, mygo.MenuItemSubmenu)
			requireTestEqual(t, len(items[1].Submenu), 3)
			favoriteEnabled := ready && p.HasSong && p.CanFavorite
			modeEnabled := ready && p.HasSong && p.CanSetMode
			requireTestEqual(t, items[0].Disabled, !favoriteEnabled)
			requireTestEqual(t, items[1].Disabled, !modeEnabled)
			favoriteLabel := "添加到收藏"
			if p.Liked {
				favoriteLabel = "取消收藏"
			}
			if items[0].Label != favoriteLabel {
				t.Fatal(items[0].Label)
			}
			items[0].Click(items[0], &mygo.Window{})
			if favoriteEnabled {
				if len(commands) != 1 || commands[0] != trayFavorite {
					t.Fatal(commands)
				}
			} else if len(commands) != 0 {
				t.Fatal("disabled favorite dispatched")
			}
			commands = nil
			for index, child := range items[1].Submenu {
				requireTestEqual(t, child.Type, mygo.MenuItemRadio)
				requireTestEqual(t, child.Disabled, !modeEnabled)
				// Model the SDK's optimistic sibling change before Click, without a Menu.
				for i, sibling := range items[1].Submenu {
					sibling.Checked = i == index
				}
				child.Click(child, &mygo.Window{})
				trayAssertChecked(t, items[1].Submenu, selected)
				if modeEnabled {
					want := []trayMenuCommand{trayModeRepeat, trayModeRepeatOnce, trayModeShuffle}[index]
					if len(commands) != 1 || commands[0] != want {
						t.Fatalf("index=%d commands=%v", index, commands)
					}
				} else if len(commands) != 0 {
					t.Fatal("disabled mode dispatched")
				}
				commands = nil
			}
			if items[1].Label != items[1].Submenu[selected].Label {
				t.Fatal("parent mode label mismatch")
			}
		}
	}
}

func TestTrayControlsRestoreBeforeDispatch(t *testing.T) {
	for selected, mode := range []TrayPlayMode{TrayModeRepeat, TrayModeRepeatOnce, TrayModeShuffle} {
		for _, outcome := range []string{"reject", "fail", "same mode"} {
			p := TrayPlaybackState{HasSong: true, CanSetMode: true, PlayMode: mode}
			var items []*mygo.MenuItem
			calls := 0
			items = buildTrayPlaybackControls(p, true, LifecycleLabels{}, nil, func(trayMenuCommand) {
				calls++
				// A stale guard rejection, emit failure, or same-state update all return
				// without rebuilding the menu. The selection must already be restored.
				trayAssertChecked(t, items[1].Submenu, selected)
			})
			for index, child := range items[1].Submenu {
				if outcome == "same mode" && index != selected {
					continue
				}
				for i, sibling := range items[1].Submenu {
					sibling.Checked = i == index
				}
				child.Click(child, nil)
				trayAssertChecked(t, items[1].Submenu, selected)
			}
			if calls == 0 {
				t.Fatal("callback never dispatched")
			}
		}
	}
	// Nil dispatch must restore too, including unsynced zero-state rendering.
	items := buildTrayPlaybackControls(TrayPlaybackState{}, false, LifecycleLabels{}, nil, nil)
	items[1].Submenu[2].Checked = true
	items[1].Submenu[0].Checked = false
	items[1].Submenu[2].Click(items[1].Submenu[2], nil)
	trayAssertChecked(t, items[1].Submenu, 0)
}

func TestTrayControlsLocalizedLabels(t *testing.T) {
	for _, labels := range []LifecycleLabels{
		{AddToFavorites: "Add to favorites", RemoveFromFavorites: "Remove from favorites", Repeat: "Repeat", RepeatOnce: "Repeat once", Shuffle: "Shuffle"},
		{AddToFavorites: "收藏歌曲", RemoveFromFavorites: "移出收藏", Repeat: "循环列表", RepeatOnce: "循环单曲", Shuffle: "随机"},
	} {
		for _, liked := range []bool{false, true} {
			for selected, mode := range []TrayPlayMode{TrayModeRepeat, TrayModeRepeatOnce, TrayModeShuffle} {
				items := buildTrayPlaybackControls(TrayPlaybackState{Liked: liked, PlayMode: mode}, true, labels, nil, nil)
				favorite := labels.AddToFavorites
				if liked {
					favorite = labels.RemoveFromFavorites
				}
				if items[0].Label != favorite {
					t.Fatal(items[0].Label)
				}
				names := []string{labels.Repeat, labels.RepeatOnce, labels.Shuffle}
				if items[1].Label != names[selected] {
					t.Fatal(items[1].Label)
				}
				for index, child := range items[1].Submenu {
					if child.Label != names[index] {
						t.Fatal(child.Label)
					}
				}
			}
		}
	}
	items := buildTrayPlaybackControls(TrayPlaybackState{PlayMode: TrayModeRepeatOnce}, false, LifecycleLabels{Repeat: "Repeat"}, nil, nil)
	if items[1].Label != "单曲循环" || items[1].Submenu[0].Label != "Repeat" || items[1].Submenu[2].Label != "随机播放" {
		t.Fatal("per-field fallback")
	}
}
