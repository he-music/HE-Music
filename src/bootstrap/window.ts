import type { PlatformKind } from "@/platform/types";
import { isDesktopLyricsWindow } from "./windowRole";

export async function bootstrapWindow(kind: PlatformKind, hash: string): Promise<void> {
  if (isDesktopLyricsWindow(kind, hash)) {
    const { mountLyricsWindow } = await import("./lyricsWindow");
    mountLyricsWindow();
    return;
  }
  const { mountMainWindow } = await import("./mainWindow");
  mountMainWindow();
}
