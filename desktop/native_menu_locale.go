package main

import (
	"github.com/egoist/mygo"
	_ "github.com/egoist/mygo/locales/zh-Hans"
)

func init() {
	// Vue owns the selected language; MyGo needs the same supported languages
	// and its Chinese catalog to translate role-based application menus.
	mygo.App.SetLanguages("zh-CN", "en")
}

func syncNativeMenuLanguage(language string) {
	if language != "" {
		// Persist even when locale resolution already chose this language, so
		// AppKit and WebKit also pick it up on the next launch.
		mygo.App.SetLocale(language)
	}
}

// WebKit caches its own language at launch. Relabel known context items when
// they open so changing the app language takes effect without restarting.
// Keep the original items so native actions, enabled states and shortcuts survive.
func localizeNativeContextMenu(event *mygo.ContextMenuEvent) {
	localizeNativeContextItems(event.Menu, mygo.App.Locale())
}

func localizeNativeContextItems(menu *mygo.Menu, language string) {
	if menu == nil {
		return
	}
	index := 0
	if language == "en" {
		index = 1
	}
	var visit func([]*mygo.MenuItem)
	visit = func(items []*mygo.MenuItem) {
		for _, item := range items {
			if labels, ok := nativeContextLabels[item.ID]; ok {
				item.SetLabel(labels[index])
			}
			visit(item.Submenu)
		}
	}
	visit(menu.Items())
}

// Keys are MyGo's stable context item IDs, never the platform's displayed text.
// Unknown system items and spelling suggestions retain their original labels.
var nativeContextLabels = map[string][2]string{
	mygo.ContextMenuBack:                 {"后退", "Back"},
	mygo.ContextMenuForward:              {"前进", "Forward"},
	mygo.ContextMenuReload:               {"重新加载", "Reload"},
	mygo.ContextMenuStop:                 {"停止加载", "Stop"},
	mygo.ContextMenuInspect:              {"检查元素", "Inspect Element"},
	mygo.ContextMenuUndo:                 {"撤销", "Undo"},
	mygo.ContextMenuRedo:                 {"重做", "Redo"},
	mygo.ContextMenuCut:                  {"剪切", "Cut"},
	mygo.ContextMenuCopy:                 {"复制", "Copy"},
	mygo.ContextMenuPaste:                {"粘贴", "Paste"},
	mygo.ContextMenuPasteAndMatchStyle:   {"粘贴并匹配样式", "Paste and Match Style"},
	mygo.ContextMenuDelete:               {"删除", "Delete"},
	mygo.ContextMenuSelectAll:            {"全选", "Select All"},
	mygo.ContextMenuOpenLink:             {"打开链接", "Open Link"},
	mygo.ContextMenuOpenLinkInNewWindow:  {"在新窗口中打开链接", "Open Link in New Window"},
	mygo.ContextMenuDownloadLink:         {"下载链接文件", "Download Linked File"},
	mygo.ContextMenuCopyLink:             {"复制链接地址", "Copy Link Address"},
	mygo.ContextMenuOpenImageInNewWindow: {"在新窗口中打开图像", "Open Image in New Window"},
	mygo.ContextMenuDownloadImage:        {"下载图像", "Download Image"},
	mygo.ContextMenuCopyImage:            {"复制图像", "Copy Image"},
	mygo.ContextMenuCopyImageURL:         {"复制图像地址", "Copy Image Address"},
	mygo.ContextMenuOpenFrameInNewWindow: {"在新窗口中打开框架", "Open Frame in New Window"},
	mygo.ContextMenuOpenMediaInNewWindow: {"在新窗口中打开媒体", "Open Media in New Window"},
	mygo.ContextMenuDownloadMedia:        {"下载媒体", "Download Media"},
	mygo.ContextMenuCopyMediaURL:         {"复制媒体地址", "Copy Media Address"},
	mygo.ContextMenuMediaControls:        {"媒体控件", "Media Controls"},
	mygo.ContextMenuMediaLoop:            {"循环播放", "Loop"},
	mygo.ContextMenuMediaFullScreen:      {"全屏", "Full Screen"},
	mygo.ContextMenuPictureInPicture:     {"画中画", "Picture in Picture"},
	mygo.ContextMenuLookUp:               {"查询所选内容", "Look Up Selection"},
	mygo.ContextMenuSearchWeb:            {"搜索网页", "Search the Web"},
	mygo.ContextMenuShare:                {"共享", "Share"},
	mygo.ContextMenuEmoji:                {"表情与符号", "Emoji & Symbols"},
	mygo.ContextMenuPrint:                {"打印", "Print"},
	"WKMenuItemIdentifierTranslateMenu":  {"翻译所选内容", "Translate Selection"},
}
