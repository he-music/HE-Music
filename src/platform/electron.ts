import { createElectronShortcuts } from "./electronShortcuts";
import { externalHttpURL, systemFromUserAgent, type PlatformAdapter } from "./types";

export function createElectronPlatform(): PlatformAdapter {
  const ipc = window.electron.ipcRenderer;
  return {
    kind: "electron",
    os: systemFromUserAgent(navigator.userAgent),
    capabilities: {
      windowControls: true,
      tray: true,
      desktopLyrics: true,
      localMusic: true,
      electronStartup: true,
    },
    shortcuts: createElectronShortcuts(),
    window: {
      async minimize() {
        ipc.send("win-min");
      },
      async toggleMaximize() {
        ipc.send(ipc.sendSync("win-state") ? "win-restore" : "win-max");
      },
      async isMaximized() {
        return Boolean(ipc.sendSync("win-state"));
      },
      async close() {
        ipc.send("quit-app");
      },
      async reload() {
        ipc.send("win-reload");
      },
      onMaximized(listener) {
        return ipc.on("win-state-change", (_event, value: boolean) => listener(value));
      },
    },
    async openExternal(url, target = "_blank") {
      // 旧 Electron 主进程通过 setWindowOpenHandler 转交系统浏览器。
      window.open(externalHttpURL(url), target, "noopener,noreferrer");
    },
  };
}
