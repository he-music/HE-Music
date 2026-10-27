import { isMyGo } from "mygo-runtime";
import { createElectronPlatform } from "./electron";
import { createMygoPlatform } from "./mygo";
import { createWebPlatform } from "./web";

// 检测真实宿主，不以桌面身份启用其他宿主的 IPC。
export const isElectronHost =
  navigator.userAgent.includes("Electron") || typeof window.electron !== "undefined";
export const platform = isMyGo()
  ? createMygoPlatform()
  : isElectronHost
    ? createElectronPlatform()
    : createWebPlatform();
