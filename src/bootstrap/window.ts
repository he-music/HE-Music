import type { PlatformKind } from "@/platform/types";
import { desktopWindowRole } from "./windowRole";

export async function bootstrapWindow(kind: PlatformKind, hash: string): Promise<void> {
  const role = desktopWindowRole(kind, hash);
  if (role === "lyrics") {
    const { mountLyricsWindow } = await import("./lyricsWindow");
    mountLyricsWindow();
    return;
  }
  if (role === "mini-player") {
    const { mountMiniPlayerWindow } = await import("./miniPlayerWindow");
    mountMiniPlayerWindow();
    return;
  }
  const { mountMainWindow } = await import("./mainWindow");
  await mountMainWindow();
}
