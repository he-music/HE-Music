import { isMyGo } from "mygo-runtime";
import { createElectronPlatform } from "./electron";
import { createMygoPlatform } from "./mygo";
import { createWebPlatform } from "./web";

const mygoHost = isMyGo();
// 检测真实宿主，不以桌面身份启用其他宿主的 IPC。
export const isElectronHost =
  !mygoHost && (navigator.userAgent.includes("Electron") || typeof window.electron !== "undefined");
export const platform = mygoHost
  ? createMygoPlatform()
  : isElectronHost
    ? createElectronPlatform()
    : createWebPlatform();
