import type { PlatformKind } from "@/platform/types";

/** 只隔离前端启动路径；原生权限仍由 Go CallerPage 验证。 */
export function desktopWindowRole(
  kind: PlatformKind,
  hash: string,
): "lyrics" | "mini-player" | undefined {
  if (kind === "web" || !hash.startsWith("#")) return undefined;
  const path = hash.slice(1).split(/[?#]/, 1)[0];
  if (path === "/desktop-lyric") return "lyrics";
  if (path === "/mini-player") return "mini-player";
  return undefined;
}
