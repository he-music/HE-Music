import { applicationStorage } from "@/platform/applicationStorage";
import { shortcutSession } from "@/platform/shortcutSession";
import { defineStore } from "pinia";

export type ShortcutType = {
  shortcut: string;
  globalShortcut: string;
  // 兼容持久化字段：true 表示冲突或注册失败
  isRegistered?: boolean;
  // 是否页内快捷键
  isPageShortcut?: boolean;
};

export interface ShortcutStore {
  globalOpen: boolean;
  shortcutList: {
    playOrPause: ShortcutType;
    playPrev: ShortcutType;
    playNext: ShortcutType;
    volumeUp: ShortcutType;
    volumeDown: ShortcutType;
    toggleDesktopLyric: ShortcutType;
    openPlayer: ShortcutType;
    openPlayList: ShortcutType;
    closePlayer: ShortcutType;
  };
}

export type ShortcutKey = keyof ShortcutStore["shortcutList"];

export const createShortcutState = (): ShortcutStore => ({
  // 全局快捷键开启
  globalOpen: true,
  // 全部快捷键
  shortcutList: {
    // 播放或暂停
    playOrPause: {
      shortcut: "CmdOrCtrl+Space",
      globalShortcut: "CmdOrCtrl+Shift+Space",
      isPageShortcut: false,
    },
    // 上一曲 / 下一曲
    playPrev: {
      shortcut: "CmdOrCtrl+ArrowLeft",
      globalShortcut: "CmdOrCtrl+Shift+Left",
      isPageShortcut: false,
    },
    playNext: {
      shortcut: "CmdOrCtrl+ArrowRight",
      globalShortcut: "CmdOrCtrl+Shift+Right",
      isPageShortcut: false,
    },
    // 音量加减
    volumeUp: {
      shortcut: "CmdOrCtrl+ArrowUp",
      globalShortcut: "CmdOrCtrl+Shift+Up",
      isPageShortcut: false,
    },
    volumeDown: {
      shortcut: "CmdOrCtrl+ArrowDown",
      globalShortcut: "CmdOrCtrl+Shift+Down",
      isPageShortcut: false,
    },
    // 桌面歌词
    toggleDesktopLyric: {
      shortcut: "CmdOrCtrl+KeyD",
      globalShortcut: "CmdOrCtrl+Shift+D",
      isPageShortcut: false,
    },
    // 打开播放界面
    openPlayer: {
      shortcut: "KeyP",
      globalShortcut: "",
      isPageShortcut: true,
    },
    // 打开播放列表
    openPlayList: {
      shortcut: "KeyL",
      globalShortcut: "",
      isPageShortcut: true,
    },
    // 关闭播放界面
    closePlayer: {
      shortcut: "Escape",
      globalShortcut: "",
      isPageShortcut: true,
    },
  },
});

export const useShortcutStore = defineStore("shortcut", {
  state: createShortcutState,
  getters: {},
  actions: {
    // 注册全部全局快捷键
    async registerAllShortcuts() {
      await shortcutSession(this)?.refresh();
    },
  },
  // 持久化
  persist: {
    key: "shortcut-store",
    storage: applicationStorage,
  },
});
