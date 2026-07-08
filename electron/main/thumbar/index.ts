import { BrowserWindow, nativeImage, nativeTheme, ThumbarButton } from "electron";
import { join } from "path";
import { isWin } from "../utils/config";
import { thumbarLog } from "../logger";
import { t } from "../i18n";

enum ThumbarKeys {
  Play = "play",
  Pause = "pause",
  Prev = "prev",
  Next = "next",
}

type ThumbarMap = Map<ThumbarKeys, ThumbarButton>;

export interface Index {
  clearThumbar(): void;
  updateThumbar(playing: boolean, clean?: boolean): void;
  updateLang(): void;
}

// 缩略图单例
let thumbar: Index | null = null;

// 工具栏图标
const thumbarIcon = (filename: string) => {
  // 是否为暗色
  const isDark = nativeTheme.shouldUseDarkColors;
  // 返回图标
  return nativeImage.createFromPath(
    join(__dirname, `../../public/icons/thumbar/${filename}-${isDark ? "dark" : "light"}.png`),
  );
};

// 缩略图工具栏
const createThumbarButtons = (win: BrowserWindow): ThumbarMap => {
  return new Map<ThumbarKeys, ThumbarButton>()
    .set(ThumbarKeys.Prev, {
      tooltip: t("common.previous"),
      icon: thumbarIcon("prev"),
      click: () => win.webContents.send("playPrev"),
    })
    .set(ThumbarKeys.Next, {
      tooltip: t("common.next"),
      icon: thumbarIcon("next"),
      click: () => win.webContents.send("playNext"),
    })
    .set(ThumbarKeys.Play, {
      tooltip: t("common.play"),
      icon: thumbarIcon("play"),
      click: () => win.webContents.send("play"),
    })
    .set(ThumbarKeys.Pause, {
      tooltip: t("common.pause"),
      icon: thumbarIcon("pause"),
      click: () => win.webContents.send("pause"),
    });
};

// 创建缩略图工具栏
class createThumbar implements Index {
  // 窗口
  private _win: BrowserWindow;
  // 工具栏
  private _thumbar: ThumbarMap;
  // 工具栏按钮
  private _prev: ThumbarButton;
  private _next: ThumbarButton;
  private _play: ThumbarButton;
  private _pause: ThumbarButton;
  // 当前播放状态
  private _isPlaying: boolean = false;
  constructor(win: BrowserWindow) {
    // 初始化数据
    this._win = win;
    this._thumbar = createThumbarButtons(win);
    // 工具栏按钮
    this._play = this._thumbar.get(ThumbarKeys.Play)!;
    this._pause = this._thumbar.get(ThumbarKeys.Pause)!;
    this._prev = this._thumbar.get(ThumbarKeys.Prev)!;
    this._next = this._thumbar.get(ThumbarKeys.Next)!;
    // 初始化工具栏
    this.updateThumbar();
    // 监听主题变化
    this.initThemeListener();
  }
  // 更新工具栏
  updateThumbar(playing: boolean = false, clean: boolean = false) {
    this._isPlaying = playing;
    if (clean) return this.clearThumbar();
    this._win.setThumbarButtons([this._prev, playing ? this._pause : this._play, this._next]);
  }
  // 清除工具栏
  clearThumbar() {
    this._win.setThumbarButtons([]);
  }

  updateLang() {
    this._play.tooltip = t("common.play");
    this._pause.tooltip = t("common.pause");
    this._prev.tooltip = t("common.previous");
    this._next.tooltip = t("common.next");
    this.updateThumbar(this._isPlaying);
  }
  // 初始化主题监听器
  private initThemeListener() {
    nativeTheme.on("updated", () => {
      this.refreshThumbarButtons();
    });
  }
  // 刷新工具栏按钮（主题变化时）
  private refreshThumbarButtons() {
    // 重新创建按钮
    this._thumbar = createThumbarButtons(this._win);
    this._play = this._thumbar.get(ThumbarKeys.Play)!;
    this._pause = this._thumbar.get(ThumbarKeys.Pause)!;
    this._prev = this._thumbar.get(ThumbarKeys.Prev)!;
    this._next = this._thumbar.get(ThumbarKeys.Next)!;
    // 更新工具栏
    this.updateThumbar(this._isPlaying);
  }
}

/**
 * 初始化缩略图工具栏
 * @param win 窗口
 * @returns 缩略图工具栏
 */
export const initThumbar = (win: BrowserWindow) => {
  try {
    // 若非 Win
    if (!isWin) return null;
    thumbarLog.info("🚀 ThumbarButtons Startup");
    thumbar = new createThumbar(win);
    return thumbar;
  } catch (error) {
    thumbarLog.error("❌ ThumbarButtons Error", error);
    throw error;
  }
};

/**
 * 获取缩略图工具栏
 * @returns 缩略图工具栏
 */
export const getThumbar = () => thumbar;
