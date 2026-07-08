import { app, ipcMain, net, powerSaveBlocker, session } from "electron";
import { ipcLog } from "../logger";
import { getFonts2 } from "font-list";
import { useStore } from "../store";
import mainWindow from "../windows/main-window";
import { changeLanguage } from "../i18n";
import { getMainTray } from "../tray";
import { getThumbar } from "../thumbar";
import { execSync } from "child_process";
import { platform } from "os";

/**
 * 初始化系统 IPC 通信
 * @returns void
 */
const initSystemIpc = (): void => {
  const store = useStore();

  /** 阻止系统息屏 ID */
  let preventId: number | null = null;

  // 是否阻止系统息屏
  ipcMain.on("prevent-sleep", (_event, val: boolean) => {
    if (val) {
      preventId = powerSaveBlocker.start("prevent-display-sleep");
      ipcLog.info("⏾ System sleep prevention started");
    } else {
      if (preventId !== null) {
        powerSaveBlocker.stop(preventId);
        ipcLog.info("✅ System sleep prevention stopped");
      }
    }
  });

  // 退出应用
  ipcMain.on("quit-app", () => {
    app.exit(0);
    app.quit();
  });

  // 获取系统全部字体
  ipcMain.handle("get-all-fonts", async () => {
    try {
      const fonts = await getFonts2({ disableQuoting: true });
      return fonts;
    } catch (error) {
      ipcLog.error(`❌ Failed to get all system fonts: ${error}`);
      return [];
    }
  });

  // 取消代理
  ipcMain.on("remove-proxy", () => {
    const mainWin = mainWindow.getWin();
    store.set("proxy", "");
    if (mainWin) {
      mainWin?.webContents.session.setProxy({ proxyRules: "" });
    }
    ipcLog.info("✅ Remove proxy successfully");
  });

  // 配置网络代理
  ipcMain.on("set-proxy", (_, config) => {
    const mainWin = mainWindow.getWin();
    if (!mainWin) return;
    const proxyRules = `${config.protocol}://${config.server}:${config.port}`;
    store.set("proxy", proxyRules);
    mainWin?.webContents.session.setProxy({ proxyRules });
    ipcLog.info("✅ Set proxy successfully:", proxyRules);
  });

  // 代理测试
  ipcMain.handle("test-proxy", async (_, config) => {
    const proxyRules = `${config.protocol}://${config.server}:${config.port}`;
    try {
      // 设置代理
      const ses = session.defaultSession;
      await ses.setProxy({ proxyRules });
      // 测试请求
      const request = net.request({ url: "https://www.baidu.com" });
      return new Promise((resolve) => {
        request.on("response", (response) => {
          if (response.statusCode === 200) {
            ipcLog.info("✅ Proxy test successful");
            resolve(true);
          } else {
            ipcLog.error(`❌ Proxy test failed with status code: ${response.statusCode}`);
            resolve(false);
          }
        });
        request.on("error", (error) => {
          ipcLog.error("❌ Error testing proxy:", error);
          resolve(false);
        });
        request.end();
      });
    } catch (error) {
      ipcLog.error("❌ Error testing proxy:", error);
      return false;
    }
  });

  // 重置全部设置
  ipcMain.on("reset-setting", () => {
    store.reset();
    ipcLog.info("✅ Reset setting successfully");
  });

  ipcMain.on("change-language", async (_, lang: string) => {
    await changeLanguage(lang);
    const tray = getMainTray();
    const thumbar = getThumbar();
    tray?.updateLang();
    thumbar?.updateLang();
  });

  // 获取设备型号名称
  ipcMain.handle("get-device-name", () => {
    try {
      const p = platform();
      if (p === "darwin") {
        // macOS: 从 system_profiler 提取 Model Name
        const output = execSync("system_profiler SPHardwareDataType", {
          encoding: "utf-8",
          timeout: 5000,
        });
        const match = output.match(/Model Name:\s*(.+)/);
        return match ? match[1].trim() : "Mac";
      }
      if (p === "win32") {
        // Windows: wmic 获取型号
        const output = execSync("wmic computersystem get model", {
          encoding: "utf-8",
          timeout: 5000,
        });
        const lines = output.trim().split("\n").filter(Boolean);
        return lines.length > 1 ? lines[1].trim() : "Windows PC";
      }
      if (p === "linux") {
        // Linux: DMI product_name
        const output = execSync("cat /sys/class/dmi/id/product_name", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return output.trim() || "Linux PC";
      }
      return "Desktop";
    } catch {
      return "Desktop";
    }
  });
};

export default initSystemIpc;
