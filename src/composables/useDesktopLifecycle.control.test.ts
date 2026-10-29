import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderer, nextTick, ref } from "vue";
import type { ControlCommand, ControlProvider } from "@/platform/controlSession";
import type { PlatformLifecycle } from "@/platform/types";

const doubles = vi.hoisted(() => {
  type Session = { completed: number; start(): Promise<void>; dispose(): Promise<void> };
  const state = { failInitialization: false };
  const sessions = new Map<string, Session[]>();
  const makeSession = (name: string): Session => {
    const session = {
      completed: 0,
      start: vi.fn(async () => {
        if (name === "media" && state.failInitialization) {
          state.failInitialization = false;
          throw new Error("synthetic lifecycle initialization failure");
        }
      }),
      dispose: vi.fn(async () => {
        await Promise.resolve();
        session.completed++;
      }),
    };
    const rows = sessions.get(name) ?? [];
    rows.push(session);
    sessions.set(name, rows);
    return session;
  };
  return {
    state,
    makeSession,
    sessions,
    platform: {} as Record<string, unknown>,
    setting: {
      showCloseAppTip: false,
      closeAppMethod: "exit",
      language: "zh-CN",
      checkUpdateOnStart: false,
    },
    status: { showDesktopLyric: false },
    music: { playSong: { id: "A", platform: "test", path: "" } },
    player: {
      play: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      playOrPause: vi.fn(async () => {}),
      nextOrPrev: vi.fn(async () => {}),
      cancelPendingAutoplay: vi.fn(),
    },
  };
});
vi.mock("@/platform", () => ({ platform: doubles.platform }));
vi.mock("@/stores", () => ({
  useSettingStore: () => doubles.setting,
  useStatusStore: () => doubles.status,
  useMusicStore: () => doubles.music,
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => doubles.player }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/shellShortcuts", () => ({
  createShellShortcutSession: () => doubles.makeSession("shortcuts"),
}));
vi.mock("@/composables/shellSystemMedia", () => ({
  createShellSystemMediaSession: () => doubles.makeSession("media"),
}));
vi.mock("@/platform/filesSession", () => ({
  createFilesSession: () => doubles.makeSession("files"),
}));
vi.mock("@/platform/localAudioSession", () => ({ blockLocalAudio: () => () => {} }));
vi.mock("@/composables/shellDesktopLyrics", () => ({
  createShellDesktopLyricsSession: () => doubles.makeSession("lyrics"),
}));
vi.mock("@/platform/desktopLyricsSession", () => ({ desktopLyricsSession: { value: undefined } }));
vi.mock("@/composables/shellUpdates", () => ({
  createShellUpdatesSession: () => doubles.makeSession("updates"),
}));
vi.mock("@/composables/shellTray", () => ({
  createShellTraySession: () => ({ ...doubles.makeSession("tray"), handle: vi.fn() }),
}));
vi.mock("@/composables/shellLocalArtwork", () => ({
  createShellLocalArtworkSession: () => doubles.makeSession("artwork"),
}));
vi.mock("@/composables/shellProtocols", () => ({
  createShellProtocolSession: () => doubles.makeSession("protocols"),
}));
vi.mock("@/composables/shellTaskbar", () => ({
  createShellTaskbarSession: () => doubles.makeSession("taskbar"),
}));
vi.mock("@/platform/windowAppearance", () => ({
  WindowAppearanceSession: class {
    private session = doubles.makeSession("appearance");
    start() {
      return this.session.start();
    }
    dispose() {
      return this.session.dispose();
    }
  },
}));
// Keep the real composable, shellControl, ControlSession and download resolver.
// In particular, no API/request/resolver mock hides import-time bootstrap errors.
const renderer = createRenderer<Record<string, unknown>, Record<string, unknown>>({
  patchProp() {},
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  parentNode: () => null,
  nextSibling: () => null,
});
const mounted = new Set<() => void>();
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
  await nextTick();
};
let useHook: typeof import("./useDesktopLifecycle").useDesktopLifecycle;
function mountShell() {
  const app = renderer.createApp({
    setup() {
      useHook({ showCloseModal: ref(false), rememberNotAsk: ref(false) });
      return () => null;
    },
  });
  const unmount = () => {
    if (mounted.delete(unmount)) app.unmount();
  };
  mounted.add(unmount);
  app.mount({});
  return unmount;
}
const sessionNames = [
  "shortcuts",
  "media",
  "files",
  "lyrics",
  "updates",
  "tray",
  "artwork",
  "protocols",
  "taskbar",
  "appearance",
];
function expectCleanup(completions: number) {
  for (const name of sessionNames) {
    const first = doubles.sessions.get(name)?.[0];
    expect(first, name).toBeDefined();
    expect(first?.dispose, name).toHaveBeenCalledTimes(completions);
    expect(first?.completed, name).toBe(completions);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  doubles.sessions.clear();
  doubles.state.failInitialization = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  [...mounted].forEach((unmount) => unmount());
  await flush();
  vi.restoreAllMocks();
});
async function fixture(failure: "start" | "teardown") {
  let generation = 0,
    epoch = 0;
  const listeners = new Set<(command: ControlCommand) => void>();
  const controlOffs: Array<ReturnType<typeof vi.fn>> = [];
  const lifecycleOffs: Array<ReturnType<typeof vi.fn>> = [];
  const provider = {
    start: vi.fn<ControlProvider["start"]>(async () => ({ generation: ++generation, port: 25666 })),
    receipt: vi.fn<ControlProvider["receipt"]>(async () => {}),
    teardown: vi.fn<ControlProvider["teardown"]>(async () => {}),
    onCommand: vi.fn<ControlProvider["onCommand"]>((listener) => {
      listeners.add(listener);
      const stop = vi.fn(() => {
        listeners.delete(listener);
      });
      controlOffs.push(stop);
      return stop;
    }),
  };
  if (failure === "start")
    provider.start.mockRejectedValueOnce(new Error("synthetic Start rejected"));
  else provider.teardown.mockRejectedValueOnce(new Error("synthetic Teardown rejected"));
  const subscribe = () => {
    const stop = vi.fn();
    lifecycleOffs.push(stop);
    return stop;
  };
  const lifecycle = {
    ready: vi.fn<PlatformLifecycle["ready"]>(async () => ({ epoch: ++epoch, trayAvailable: true })),
    teardown: vi.fn<PlatformLifecycle["teardown"]>(async () => {}),
    syncConfig: vi.fn<PlatformLifecycle["syncConfig"]>(async () => {}),
    onCloseRequested: subscribe,
    onTrayAction: subscribe,
  };
  Object.assign(doubles.platform, {
    kind: "mygo",
    lifecycle,
    playbackControl: provider,
    files: {},
    protocols: {},
    taskbar: {},
    windowAppearance: {},
  });
  // One import per test, not per mount: remount must reuse the actual shared
  // shellTransition and cannot escape a rejected queue by resetting modules.
  useHook = (await import("./useDesktopLifecycle")).useDesktopLifecycle;
  return {
    provider,
    lifecycle,
    controlOffs,
    lifecycleOffs,
    listeners,
    emit: () =>
      listeners.forEach((listener) => listener({ generation, requestId: 1, action: "play" })),
  };
}

describe("useDesktopLifecycle control cleanup on the CPU renderer", () => {
  it.each(["start", "teardown"] as const)(
    "finishes unmount cleanup and lets remount start after control %s rejects",
    async (failure) => {
      const f = await fixture(failure);
      const unmount = mountShell();
      await flush();
      expect(f.provider.start).toHaveBeenCalledOnce();
      unmount();
      await flush();
      expectCleanup(1);
      expect(f.lifecycle.teardown).toHaveBeenCalledOnce();
      expect(f.controlOffs[0]).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(0);
      f.lifecycleOffs.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
      expect(console.error).toHaveBeenCalledWith("桌面生命周期操作失败");
      mountShell();
      await flush();
      expect(f.lifecycle.ready).toHaveBeenCalledTimes(2);
      expect(f.provider.start).toHaveBeenCalledTimes(2);
      expect(doubles.sessions.get("media")?.[1].start).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(1);
      f.emit();
      await flush();
      expect(doubles.player.play).toHaveBeenCalledOnce();
      expect(f.provider.receipt).toHaveBeenCalledWith(failure === "start" ? 1 : 2, 1, true);
      expect(f.provider.teardown).toHaveBeenCalledTimes(failure === "start" ? 0 : 1);
    },
  );

  it.each(["start", "teardown"] as const)(
    "continues initialization-failure cleanup when control dispose rejects from %s",
    async (failure) => {
      const f = await fixture(failure);
      doubles.state.failInitialization = true;
      const unmount = mountShell();
      await flush();
      expect(f.provider.start).toHaveBeenCalledOnce();
      expect(doubles.sessions.get("media")?.[0].start).toHaveBeenCalledOnce();
      expectCleanup(1);
      expect(f.lifecycle.teardown).toHaveBeenCalledOnce();
      expect(f.controlOffs[0]).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(0);
      f.lifecycleOffs.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
      unmount();
      await flush();
      expectCleanup(2);
      expect(f.lifecycle.teardown).toHaveBeenCalledTimes(2);
      mountShell();
      await flush();
      expect(f.lifecycle.ready).toHaveBeenCalledTimes(2);
      expect(f.provider.start).toHaveBeenCalledTimes(2);
      expect(doubles.sessions.get("media")?.[1].start).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(1);
      f.emit();
      await flush();
      expect(doubles.player.play).toHaveBeenCalledOnce();
      expect(f.provider.receipt).toHaveBeenCalledWith(failure === "start" ? 1 : 2, 1, true);
    },
  );
});
