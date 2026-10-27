import { isElectronHost, platform } from "@/platform";

/** 是否为开发环境 */
export const isDev = import.meta.env.MODE === "development" || import.meta.env.DEV;

/** 系统判断 */
export const userAgent = window.navigator.userAgent;

/** 是否为 Windows 系统 */
export const isWin = platform.os === "win32";
/** 是否为 macOS 系统 */
export const isMac = platform.os === "darwin";
/** 是否为 Linux 系统 */
export const isLinux = platform.os === "linux";
/** 是否为 Electron 环境 */
export const isElectron = isElectronHost;

/** 是否为 mygo 环境（不会启用 Electron IPC） */
export const isMygo = platform.kind === "mygo";

/** 原生 provider 接管时避免 Web MediaSession 重复发布。 */
export const hasNativeSystemMedia = isMygo && Boolean(platform.systemMedia);
