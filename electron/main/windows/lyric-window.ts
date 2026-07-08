import { BrowserWindow, screen } from "electron";
import { createWindow } from "./index";
import { useStore } from "../store";
import { appName, lyricWinUrl } from "../utils/config";
import mainWindow from "./main-window";
import { resolveLyricWindowBounds } from "./lyric-window-position";

class LyricWindow {
  private win: BrowserWindow | null = null;
  constructor() {}
  /**
   * 主窗口事件
   * @returns void
   */
  private event(): void {
    if (!this.win) return;
    // 准备好显示
    this.win.on("ready-to-show", () => {
      this.win?.showInactive();
    });
    // 页面加载完成后设置标题
    // 这里的标题设置是为了 Linux 能够为桌面歌词单独设置窗口规则
    this.win.webContents.on("did-finish-load", () => {
      this.win?.setTitle(`${appName} - 桌面歌词`);
    });
    // 歌词窗口缩放
    this.win?.on("resized", () => {
      const store = useStore();
      const bounds = this.win?.getBounds();
      if (bounds) {
        const { width, height } = bounds;
        store.set("lyric", { ...store.get("lyric"), width, height });
      }
    });
    // 歌词窗口关闭
    this.win?.on("close", () => {
      this.win = null;
      const mainWin = mainWindow?.getWin();
      if (mainWin) {
        mainWin?.webContents.send("closeDesktopLyric");
      }
    });
  }
  /**
   * 创建主窗口
   * @returns BrowserWindow | null
   */
  create(): BrowserWindow | null {
    const store = useStore();
    const { width, height, x, y } = store.get("lyric");
    const safeWidth = width || 800;
    const safeHeight = height || 180;
    const hasStoredPosition = Number.isFinite(x) && Number.isFinite(y);
    const virtualBounds = screen.getAllDisplays().reduce(
      (result, display) => {
        const { x, y, width, height } = display.workArea;
        return {
          minX: Math.min(result.minX, x),
          minY: Math.min(result.minY, y),
          maxX: Math.max(result.maxX, x + width),
          maxY: Math.max(result.maxY, y + height),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      },
    );
    const resolvedBounds = hasStoredPosition
      ? resolveLyricWindowBounds(
          {
            x: Number(x),
            y: Number(y),
            width: safeWidth,
            height: safeHeight,
          },
          virtualBounds,
        )
      : null;
    if (resolvedBounds && (resolvedBounds.x !== Number(x) || resolvedBounds.y !== Number(y))) {
      store.set("lyric", {
        ...store.get("lyric"),
        x: resolvedBounds.x,
        y: resolvedBounds.y,
      });
    }
    this.win = createWindow({
      width: safeWidth,
      height: safeHeight,
      minWidth: 640,
      minHeight: 140,
      maxWidth: 1400,
      maxHeight: 360,
      // 没有指定位置时居中显示
      center: !hasStoredPosition,
      // 窗口位置
      x: resolvedBounds?.x,
      y: resolvedBounds?.y,
      transparent: true,
      hasShadow: false,
      backgroundColor: "rgba(0, 0, 0, 0)",
      alwaysOnTop: true,
      resizable: true,
      movable: true,
      show: false,
      // 不在任务栏显示
      skipTaskbar: true,
      // 窗口不能最小化
      minimizable: false,
      // 窗口不能最大化
      maximizable: false,
      // 窗口不能进入全屏状态
      fullscreenable: false,
    });
    if (!this.win) return null;
    // 加载地址
    this.win.loadURL(lyricWinUrl);
    // 窗口事件
    this.event();
    return this.win;
  }
  /**
   * 获取窗口
   * @returns BrowserWindow | null
   */
  getWin(): BrowserWindow | null {
    if (this.win && !this.win?.isDestroyed()) return this.win;
    return null;
  }
}

export default new LyricWindow();
