import { shallowReactive } from "vue";
import { currentWindow, runtime } from "mygo-runtime";
import {
  DesktopLifecycle,
  DesktopLyrics,
  DesktopPlatform,
  GlobalShortcuts,
  SystemMedia,
  NativeFiles,
  Updates,
  events,
} from "./mygo.bindings";
import { externalHttpURL, type PlatformAdapter } from "./types";
import { playbackShortcutActions } from "./shortcuts";
import { desktopLyricsSession } from "./desktopLyricsSession";
import { filesSession } from "./filesSession";

export function createMygoPlatform(): PlatformAdapter {
  const os = runtime().platform;
  const capabilities = shallowReactive({
    windowControls: true,
    tray: false,
    get desktopLyrics() {
      return desktopLyricsSession.value?.ready.value === true;
    },
    get localMusic() {
      return filesSession.value?.ready.value === true;
    },
    electronStartup: false,
  });
  return {
    kind: "mygo",
    os: os === "darwin" || os === "win32" || os === "linux" ? os : "unknown",
    capabilities,
    files: NativeFiles,
    updates: {
      ...Updates,
      onChange: (listener) => events.desktopUpdates.on(listener),
    },
    desktopLyrics: {
      ...DesktopLyrics,
      onWindow: (listener) => events.desktopLyricsWindow.on(listener),
      onSnapshot: (listener) => events.desktopLyricsSnapshot.on(listener),
      onClock: (listener) => events.desktopLyricsClock.on(listener),
      onCommand: (listener) => events.desktopLyricsCommand.on(listener),
    },
    systemMedia: {
      ...SystemMedia,
      onCommand: (listener) => events.desktopSystemMediaCommand.on(listener),
    },
    shortcuts: {
      ...GlobalShortcuts,
      actions: [...playbackShortcutActions, "toggleDesktopLyric"],
      replace: (generation, enabled, bindings) =>
        GlobalShortcuts.replace(generation, enabled, bindings),
      onAction: (listener) => events.desktopShortcutAction.on(listener),
    },
    lifecycle: {
      ...DesktopLifecycle,
      async ready(config) {
        capabilities.tray = false;
        const status = await DesktopLifecycle.ready(config);
        capabilities.tray = status.trayAvailable;
        return status;
      },
      async teardown() {
        capabilities.tray = false;
        await DesktopLifecycle.teardown();
      },
      onCloseRequested: (listener) => events.desktopCloseRequested.on(listener),
      onTrayAction: (listener) => events.desktopTrayAction.on(listener),
    },
    window: {
      minimize: currentWindow.minimize,
      toggleMaximize: currentWindow.toggleMaximize,
      isMaximized: currentWindow.isMaximized,
      close: currentWindow.close,
      async reload() {
        location.reload();
      },
      onMaximized: (listener) => events.desktopWindowMaximized.on(listener),
    },
    openExternal: async (url) => DesktopPlatform.openExternal(externalHttpURL(url)),
  };
}
