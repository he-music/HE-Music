package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestNativeContextMenuLanguageSwitchPreservesActions(t *testing.T) {
	clicks := 0
	copyItem := &mygo.MenuItem{
		ID: mygo.ContextMenuCopy, Label: "Copy", Accelerator: "CmdOrCtrl+C", Disabled: true,
		Click: func(*mygo.MenuItem, *mygo.Window) { clicks++ },
	}
	loop := &mygo.MenuItem{ID: mygo.ContextMenuMediaLoop, Label: "Loop", Type: mygo.MenuItemCheckbox, Checked: true}
	unknown := &mygo.MenuItem{ID: mygo.ContextMenuSpellingGuess, Label: "suggested word"}
	menu := mygo.NewMenu([]*mygo.MenuItem{
		copyItem,
		{Label: "Nested", Submenu: []*mygo.MenuItem{loop, unknown}},
	})
	for _, want := range []struct{ language, copy, loop string }{
		{"zh-CN", "复制", "循环播放"},
		{"en", "Copy", "Loop"},
		{"zh-CN", "复制", "循环播放"},
	} {
		localizeNativeContextItems(menu, want.language)
		requireTestEqual(t, copyItem.Label, want.copy)
		requireTestEqual(t, loop.Label, want.loop)
		requireTestEqual(t, copyItem.Disabled, true)
		requireTestEqual(t, copyItem.Accelerator, "CmdOrCtrl+C")
		requireTestEqual(t, loop.Checked, true)
		requireTestEqual(t, loop.Type, mygo.MenuItemCheckbox)
		requireTestEqual(t, unknown.Label, "suggested word")
		copyItem.Click(copyItem, nil)
	}
	requireTestEqual(t, clicks, 3)
	localizeNativeContextItems(nil, "zh-CN")
}

func TestLifecycleConfigLanguageValidation(t *testing.T) {
	for _, language := range []string{"", "zh-CN", "en", "invalid"} {
		err := validateLifecycleConfig(LifecycleConfig{CloseAppMethod: CloseAppHide, Language: language})
		if (err == nil) != (language != "invalid") {
			t.Fatalf("language %q: unexpected validation result: %v", language, err)
		}
	}
}
