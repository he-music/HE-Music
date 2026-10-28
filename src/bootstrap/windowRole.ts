import type { PlatformKind } from "@/platform/types";

/** 只隔离前端启动路径；原生权限仍由 Go CallerPage 验证。 */
export function isDesktopLyricsWindow(kind: PlatformKind, hash: string): boolean {
  if (kind === "web" || !hash.startsWith("#")) return false;
  return hash.slice(1).split(/[?#]/, 1)[0] === "/desktop-lyric";
}
