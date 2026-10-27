import { externalHttpURL, systemFromUserAgent, type PlatformAdapter } from "./types";

export function createWebPlatform(): PlatformAdapter {
  return {
    kind: "web",
    os: systemFromUserAgent(navigator.userAgent),
    capabilities: {
      windowControls: false,
      tray: false,
      desktopLyrics: false,
      localMusic: false,
      electronStartup: false,
    },
    window: null,
    async openExternal(url, target = "_blank") {
      window.open(externalHttpURL(url), target, "noopener,noreferrer");
    },
  };
}
