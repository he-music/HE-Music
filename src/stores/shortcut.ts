import { cloneDeep } from "lodash-es";
import { defineStore } from "pinia";

type ShortcutType = {
  shortcut: string;
  globalShortcut: string;
  // 是否被注册
  isRegistered?: boolean;
  // 是否页内快捷键
  isPageShortcut?: boolean;
};

interface ShortcutStore {
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

export const useShortcutStore = defineStore("shortcut", {
  state: (): ShortcutStore => ({
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
  }),
  getters: {},
  actions: {
    // 注册全部全局快捷键
    async registerAllShortcuts() {
      if (!this.globalOpen) return;
      const result = await window.electron.ipcRenderer.invoke(
        "register-all-shortcut",
        cloneDeep(this.shortcutList),
      );
      console.log(result);
      return result;
    },
  },
  // 持久化
  persist: {
    key: "shortcut-store",
    storage: localStorage,
  },
});
