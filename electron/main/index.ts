import { app, BrowserWindow } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { release, type } from "os";
import { isMac } from "./utils/config";
import { unregisterShortcuts } from "./shortcut";
import { initTray, MainTray } from "./tray";
import { processLog } from "./logger";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import initAppServer from "../server";
import { initSingleLock } from "./utils/single-lock";
import loadWindow from "./windows/load-window";
import mainWindow from "./windows/main-window";
import initIpc from "./ipc";
import { initI18n } from "./i18n";
import { trySendCustomProtocol } from "./utils/protocol";

// 屏蔽报错
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

// 便携模式下设置用户数据路径
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  processLog.info(
    "🔍 Portable mode detected, setting userData path to:",
    join(process.env.PORTABLE_EXECUTABLE_DIR, "UserData"),
  );
  const userDataPath = join(process.env.PORTABLE_EXECUTABLE_DIR, "UserData");
  if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
}

// 主进程
class MainProcess {
  // 窗口
  mainWindow: BrowserWindow | null = null;
  loadWindow: BrowserWindow | null = null;
  // 托盘
  mainTray: MainTray | null = null;
  constructor() {
    processLog.info("🚀 Main process startup");
    // 程序单例锁
    initSingleLock();
    // 禁用 Windows 7 的 GPU 加速功能
    if (release().startsWith("6.1") && type() == "Windows_NT") app.disableHardwareAcceleration();
    // 监听应用事件
    this.handleAppEvents();
    // Electron 初始化完成后
    // 某些 API 只有在此事件发生后才能使用
    app.whenReady().then(async () => {
      processLog.info("🚀 Application Process Startup");
      // 设置应用程序名称
      electronApp.setAppUserModelId("com.hemusic.music");
      // 启动主服务进程
      await initAppServer();
      // 初始化 i18n
      await initI18n();
      // 启动窗口
      this.loadWindow = loadWindow.create();
      this.mainWindow = mainWindow.create();
      // 注册其他服务
      this.mainTray = initTray(this.mainWindow!);
      // 注册 IPC 通信
      initIpc();
    });
  }
  // 应用程序事件
  handleAppEvents() {
    // 窗口被关闭时
    app.on("window-all-closed", () => {
      processLog.info("❌ All windows have been closed");
      if (!isMac) app.quit();
      this.mainWindow = null;
      this.loadWindow = null;
    });

    // 应用被激活
    app.on("activate", () => {
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length) {
        allWindows[0].focus();
      }
    });

    // 自定义协议
    app.on("open-url", (_, url) => {
      processLog.log("🔗 Received custom protocol URL:", url);
      trySendCustomProtocol(url);
    });

    // 将要退出
    app.on("will-quit", () => {
      // 注销全部快捷键
      unregisterShortcuts();
    });

    // 退出前
    app.on("before-quit", () => {
      processLog.info("🚀 Application is about to quit");
      mainWindow.isQuit = true;
    });
  }
}

export default new MainProcess();
