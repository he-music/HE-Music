import {
  app,
  Tray,
  Menu,
  MenuItemConstructorOptions,
  BrowserWindow,
  nativeImage,
  nativeTheme,
} from "electron";
import { isWin, isLinux, isDev, appName, isMac } from "../utils/config";
import { join } from "path";
import { trayLog } from "../logger";
import { useStore } from "../store";
import lyricWindow from "../windows/lyric-window";
import { t } from "../i18n";

// 播放模式
type PlayMode = "repeat" | "repeat-once" | "shuffle";
type PlayState = "play" | "pause" | "loading";

// 全局数据
let playMode: PlayMode = "repeat";
let playState: PlayState = "pause";
let playName: string = "";
let likeSong: boolean = false;
let desktopLyricShow: boolean = false;
let desktopLyricLock: boolean = false;
let songValid: boolean = false;

export interface MainTray {
  setTitle(title: string): void;
  setPlayMode(mode: PlayMode): void;
  setLikeState(like: boolean): void;
  setPlayState(state: PlayState): void;
  setPlayName(name: string): void;
  setDesktopLyricShow(show: boolean): void;
  setDesktopLyricLock(lock: boolean): void;
  destroyTray(): void;
  setSongValid(valid: boolean): void;
  updateLang(): void;
}

// 托盘单例
let mainTrayInstance: MainTray | null = null;

// 托盘图标
const trayIcon = (filename: string) => {
  // const rootPath = isDev
  //   ? join(__dirname, "../../public/icons/tray")
  //   : join(app.getAppPath(), "../../public/icons/tray");
  // return nativeImage.createFromPath(join(rootPath, filename));
  return nativeImage.createFromPath(join(__dirname, `../../public/icons/tray/${filename}`));
};

// 托盘菜单
const createTrayMenu = (win: BrowserWindow): MenuItemConstructorOptions[] => {
  // 区分明暗图标
  const showIcon = (iconName: string, enabled = true) => {
    const isDark = nativeTheme.shouldUseDarkColors;
    return trayIcon(
      `${iconName}${isDark ? "-dark" : "-light"}${enabled ? "" : "-disabled"}.png`,
    ).resize({
      width: 16,
      height: 16,
    });
  };
  // 菜单
  const menu: MenuItemConstructorOptions[] = [
    {
      id: "name",
      label: songValid ? playName : t("common.no_song_playing"),
      icon: showIcon("music"),
      click: () => {
        win.show();
        win.focus();
      },
    },
    {
      type: "separator",
    },
    {
      id: "toggleLikeSong",
      label: likeSong ? t("common.remove_from_favorites") : t("common.add_to_favorites"),
      icon: showIcon(likeSong ? "like" : "unlike", songValid),
      click: () => win.webContents.send("toggleLikeSong"),
      enabled: songValid,
    },
    {
      id: "changeMode",
      label:
        playMode === "repeat"
          ? t("common.play_mode_repeat")
          : playMode === "repeat-once"
            ? t("common.play_mode_repeat_once")
            : t("common.play_mode_shuffle"),
      icon: showIcon(playMode, songValid),
      enabled: songValid,
      submenu: [
        {
          id: "repeat",
          label: t("common.play_mode_repeat"),
          icon: showIcon("repeat"),
          checked: playMode === "repeat",
          type: "radio",
          click: () => win.webContents.send("changeMode", "repeat"),
        },
        {
          id: "repeat-once",
          label: t("common.play_mode_repeat_once"),
          icon: showIcon("repeat-once"),
          checked: playMode === "repeat-once",
          type: "radio",
          click: () => win.webContents.send("changeMode", "repeat-once"),
        },
        {
          id: "shuffle",
          label: t("common.play_mode_shuffle"),
          icon: showIcon("shuffle"),
          checked: playMode === "shuffle",
          type: "radio",
          click: () => win.webContents.send("changeMode", "shuffle"),
        },
      ],
    },
    {
      type: "separator",
    },
    {
      id: "playNext",
      label: t("common.previous"),
      icon: showIcon("prev", songValid),
      click: () => win.webContents.send("playPrev"),
      enabled: songValid,
    },
    {
      id: "playOrPause",
      label: playState === "pause" ? t("common.play") : t("common.pause"),
      icon: showIcon(playState === "pause" ? "play" : "pause", songValid),
      click: () => win.webContents.send(playState === "pause" ? "play" : "pause"),
      enabled: songValid,
    },
    {
      id: "playNext",
      label: t("common.next"),
      icon: showIcon("next", songValid),
      click: () => win.webContents.send("playNext"),
      enabled: songValid,
    },
    {
      type: "separator",
    },
    {
      id: "toggleDesktopLyric",
      label: desktopLyricShow ? t("common.hide_desktop_lyrics") : t("common.show_desktop_lyrics"),
      icon: showIcon("lyric"),
      click: () => win.webContents.send("toggleDesktopLyric"),
    },
    {
      id: "toggleDesktopLyricLock",
      label: desktopLyricLock ? t("common.unlock_desktop_lyrics") : t("common.lock_desktop_lyrics"),
      icon: showIcon(desktopLyricLock ? "lock" : "unlock"),
      visible: desktopLyricShow,
      click: () => {
        const store = useStore();
        // 更新锁定状态
        store.set("lyric.config", { ...store.get("lyric.config"), isLock: !desktopLyricLock });
        // 触发窗口更新
        const config = store.get("lyric.config");
        const lyricWin = lyricWindow.getWin();
        if (!lyricWin) return;
        lyricWin.webContents.send("update-desktop-lyric-option", config);
      },
    },
    {
      type: "separator",
    },
    {
      id: "setting",
      label: t("common.setting"),
      icon: showIcon("setting"),
      click: () => {
        win.show();
        win.focus();
        win.webContents.send("openSetting");
      },
    },
    {
      type: "separator",
    },
    {
      id: "exit",
      label: t("common.exit"),
      icon: showIcon("power"),
      click: () => {
        app.exit(0);
        app.quit();
      },
    },
  ];
  return menu;
};

// 创建托盘
class CreateTray implements MainTray {
  // 窗口
  private _win: BrowserWindow;
  // 托盘
  private _tray: Tray;
  // 菜单
  private _menu: MenuItemConstructorOptions[];
  private _contextMenu: Menu;

  trayIcon() {
    if (isWin) {
      return trayIcon("tray.ico").resize({ height: 32, width: 32 });
    }
    if (isMac) {
      const icon = trayIcon(`trayTemplate.png`).resize({ height: 18, width: 18 });
      icon.setTemplateImage(true);
      return icon;
    }

    return trayIcon("tray.png").resize({
      height: 32,
      width: 32,
    });
  }

  constructor(win: BrowserWindow) {
    // 托盘图标
    const icon = this.trayIcon();
    // 初始化数据
    this._win = win;
    this._tray = new Tray(icon);
    this._menu = createTrayMenu(this._win);
    this._contextMenu = Menu.buildFromTemplate(this._menu);
    // 初始化事件
    this.initTrayMenu();
    this.initEvents();
    this.setTitle(appName);
  }
  // 托盘菜单
  private initTrayMenu() {
    this._menu = createTrayMenu(this._win);
    this._contextMenu = Menu.buildFromTemplate(this._menu);
    // macOS 下不使用 setContextMenu，避免左右键都弹出菜单
    // 改为在 right-click 事件中手动弹出
    if (!isMac) {
      this._tray.setContextMenu(this._contextMenu);
    }
  }
  // 托盘事件
  private initEvents() {
    // 明暗变化
    nativeTheme.on("updated", () => {
      this.initTrayMenu();
    });
    // 左键点击托盘图标，显示主窗口
    this._tray.on("click", () => {
      this._win.show();
      this._win.focus();
    });
    // macOS：右键手动弹出上下文菜单
    if (isMac) {
      this._tray.on("right-click", () => {
        this._tray.popUpContextMenu(this._contextMenu);
      });
    }
  }
  /**
   * 设置标题
   * @param title 标题
   */
  setTitle(title: string) {
    this._win.setTitle(title);
    this._tray.setTitle(title);
    this._tray.setToolTip(title);
  }
  /**
   * 设置播放名称
   * @param name 播放名称
   */
  setPlayName(name: string = "") {
    // 超长处理
    if (name.length > 20) name = name.slice(0, 20) + "...";
    playName = name;
    // 更新菜单
    this.initTrayMenu();
  }
  /**
   * 设置播放状态
   * @param state 播放状态
   */
  setPlayState(state: PlayState) {
    playState = state;
    // 更新菜单
    this.initTrayMenu();
  }
  /**
   * 设置播放模式
   * @param mode 播放模式
   */
  setPlayMode(mode: PlayMode) {
    playMode = mode;
    // 更新菜单
    this.initTrayMenu();
  }
  /**
   * 设置喜欢状态
   * @param like 喜欢状态
   */
  setLikeState(like: boolean) {
    likeSong = like;
    // 更新菜单
    this.initTrayMenu();
  }
  /**
   * 桌面歌词开关
   * @param show 桌面歌词开关状态
   */
  setDesktopLyricShow(show: boolean) {
    desktopLyricShow = show;
    // 更新菜单
    this.initTrayMenu();
  }
  /**
   * 锁定桌面歌词
   * @param lock 锁定桌面歌词状态
   */
  setDesktopLyricLock(lock: boolean) {
    desktopLyricLock = lock;
    // 更新菜单
    this.initTrayMenu();
  }
  // 销毁托盘
  destroyTray() {
    this._tray.destroy();
  }
  // 设置歌曲是否有效
  setSongValid(valid: boolean) {
    songValid = valid;
  }
  updateLang() {
    this.initTrayMenu();
  }
}
/**
 * 初始化托盘
 * @param win 主窗口
 * @returns 托盘实例
 */
export const initTray = (win: BrowserWindow) => {
  try {
    // 若为 MacOS
    if (isWin || isLinux || isMac || isDev) {
      trayLog.info("🚀 Tray Process Startup");
      mainTrayInstance = new CreateTray(win);
      return mainTrayInstance;
    }
    return null;
  } catch (error) {
    trayLog.error("❌ Tray Process Error", error);
    return null;
  }
};

/**
 * 获取托盘实例
 * @returns 托盘实例
 */
export const getMainTray = (): MainTray | null => mainTrayInstance;
