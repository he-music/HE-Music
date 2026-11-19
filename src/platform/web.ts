import { externalHttpURL, systemFromUserAgent, type PlatformAdapter } from "./types";
import { createWebFullscreen } from "./webFullscreen";

export function createWebPlatform(): PlatformAdapter {
  return {
    kind: "web",
    os: systemFromUserAgent(navigator.userAgent),
    capabilities: {
      windowControls: false,
      tray: false,
      desktopLyrics: false,
      localMusic: false,
    },
    window: null,
    fullscreen: createWebFullscreen(globalThis.document),
    async openExternal(url, target = "_blank") {
      window.open(externalHttpURL(url), target, "noopener,noreferrer");
    },
  };
}
