import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { DesktopLyricsSession } from "@/platform/desktopLyricsSession";
import type { LyricsWindowState, PlatformDesktopLyrics } from "@/platform/desktopLyrics";
import type { TrayAction, TrayRequest, TrayPlaybackState } from "@/platform/mygo.bindings";
import { WindowAppearanceSession, windowAppearanceSession } from "@/platform/windowAppearance";

type ShellSessionStub = { start: () => Promise<void>; dispose: () => Promise<void> };
type ArtworkSessionStub = { dispose: () => void };
const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", capabilities: { tray: true, windowControls: false }, lifecycle: {} },
  setting: {} as Record<string, unknown>,
  status: {} as Record<string, unknown>,
  music: {} as Record<string, unknown>,
  player: { playOrPause: vi.fn(), nextOrPrev: vi.fn() },
  openSetting: vi.fn().mockResolvedValue(undefined),
  lyrics: undefined as ShellSessionStub | undefined,
  media: undefined as ShellSessionStub | undefined,
  files: undefined as ShellSessionStub | undefined,
  updates: undefined as ShellSessionStub | undefined,
  artwork: undefined as ArtworkSessionStub | undefined,
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/stores", () => ({
  useSettingStore: () => mocks.setting,
  useStatusStore: () => mocks.status,
  useMusicStore: () => mocks.music,
  useDataStore: () => ({ userData: { id: "" }, userLoginStatus: false, isLikeSong: () => false }),
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("@/utils/modal", () => ({ openSetting: mocks.openSetting }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/shellDesktopLyrics", () => ({
  createShellDesktopLyricsSession: () => mocks.lyrics,
}));
vi.mock("@/composables/shellSystemMedia", () => ({
  createShellSystemMediaSession: () => mocks.media,
}));
vi.mock("@/platform/filesSession", () => ({ createFilesSession: () => mocks.files }));
vi.mock("@/composables/shellUpdates", () => ({ createShellUpdatesSession: () => mocks.updates }));
vi.mock("@/composables/shellLocalArtwork", () => ({
  createShellLocalArtworkSession: () => mocks.artwork,
}));
vi.mock("@/composables/shellProtocols", () => ({ createShellProtocolSession: () => undefined }));
vi.mock("@/composables/shellTaskbar", () => ({ createShellTaskbarSession: () => undefined }));
import { useDesktopLifecycle } from "@/composables/useDesktopLifecycle";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
};
const unmounts: Array<() => void> = [];
afterEach(async () => {
  unmounts.splice(0).forEach((unmount) => unmount());
  await flush();
  vi.restoreAllMocks();
  mocks.lyrics = undefined;
  mocks.media = undefined;
  mocks.files = undefined;
  mocks.updates = undefined;
  mocks.artwork = undefined;
  vi.unstubAllGlobals();
  windowAppearanceSession.value?.dispose();
  mocks.platform.capabilities.windowControls = false;
  Reflect.deleteProperty(mocks.platform, "window");
});

function mountNav(options: { ready?: Promise<{ trayAvailable: boolean; epoch: number }> } = {}) {
  mocks.setting = Vue.reactive({
    showCloseAppTip: true,
    closeAppMethod: "exit",
    language: "zh-CN",
  });
  mocks.status = Vue.reactive({ playStatus: false, currentTime: 0, lyricClock: 0 });
  mocks.music = Vue.reactive({ playSong: { id: "synthetic", platform: "synthetic", path: "" } });
  mocks.player.playOrPause = vi.fn().mockResolvedValue(undefined);
  mocks.player.nextOrPrev = vi.fn().mockResolvedValue(undefined);
  const closeHandlers = new Set<(request: { requestId: number }) => void>();
  const actions = new Set<(action: TrayRequest) => void>();
  const service = {
    ready: vi.fn(() => options.ready ?? Promise.resolve({ trayAvailable: true, epoch: 1 })),
    teardown: vi.fn(async () => {}),
    syncConfig: vi.fn(async () => {}),
    syncPlayback: vi.fn<(snapshot: TrayPlaybackState) => Promise<void>>(async () => {}),
    acknowledgeClose: vi.fn(async () => {}),
    resolveClose: vi.fn(async () => {}),
    onCloseRequested: (handler: (request: { requestId: number }) => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onTrayAction: (handler: (action: TrayRequest) => void) => {
      actions.add(handler);
      return () => actions.delete(handler);
    },
  };
  mocks.platform.lifecycle = service;
  vi.stubGlobal("window", { $message: { error: vi.fn() } });
  const source = readFileSync(new URL("./Nav.vue", import.meta.url), "utf8").replace(
    '<script setup lang="ts">',
    '<script setup lang="ts">\nconst useRouter = () => ({});',
  );
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: "Nav.vue" });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/stores": { useSettingStore: () => mocks.setting },
    "@/platform": { platform: mocks.platform },
    "@/utils/helper": {},
    "@/utils/env": { isElectron: false, isMac: true },
    "@/utils/modal": {},
    "@/constants/links": {},
    "@/composables/useMobile": {
      useMobile: () => ({ isDesktop: Vue.ref(true), isSmallScreen: Vue.ref(false) }),
    },
    "@/composables/useDesktopLifecycle": { useDesktopLifecycle },
    "@/platform/windowAppearance": { windowAppearanceSession },
    "@/components/Layout/Menu.vue": {},
    "@/components/Layout/Logo.vue": {},
  };
  const exports: { default?: { setup: (props: object, ctx: object) => Record<string, unknown> } } =
    {};
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, exports);
  let state: Record<string, unknown> = {};
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      state = exports.default!.setup({}, { expose() {} });
      return () => null;
    },
  });
  app.mount({});
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  unmounts.push(unmount);
  return {
    service,
    closeHandlers,
    actions,
    unmount,
    requestClose: () => (state.tryClose as () => void)(),
    nativeBorderless: () => Vue.unref(state.nativeBorderless),
    windowControls: () => Vue.unref(state.showWindowControls),
    close(id = 1) {
      closeHandlers.forEach((handler) => handler({ requestId: id }));
    },
    action(action: TrayAction) {
      const snapshot = service.syncPlayback.mock.calls.at(-1)?.[0];
      if (snapshot)
        actions.forEach((handler) =>
          handler({
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            trackKey: snapshot.trackKey,
            action,
          }),
        );
    },
    modal: () => state.showCloseModal as Vue.Ref<boolean>,
    remember: () => state.rememberNotAsk as Vue.Ref<boolean>,
    choose: (action: "hide" | "exit") => (state.hideOrClose as (a: string) => void)(action),
  };
}

describe("Nav native lifecycle setup", () => {
  it.each([true, false])(
    "routes the custom mygo close button through native lifecycle when showCloseAppTip=%s",
    async (showCloseAppTip) => {
      const closeWindow = vi.fn(async () => {});
      Reflect.set(mocks.platform, "window", {
        close: closeWindow,
        onMaximized: () => () => {},
        isMaximized: async () => false,
      });
      const nav = mountNav();
      await flush();
      mocks.setting.showCloseAppTip = showCloseAppTip;
      nav.requestClose();
      expect(closeWindow).toHaveBeenCalledOnce();
      expect(nav.modal().value).toBe(false);
      nav.close(9);
      await flush();
      expect(nav.modal().value).toBe(true);
      nav.choose("exit");
      await flush();
      expect(nav.service.resolveClose).toHaveBeenCalledExactlyOnceWith(9, "exit");
    },
  );
  it("keeps controls available if appearance loading fails, and changes them only with applied frame state", async () => {
    mocks.platform.capabilities.windowControls = true;
    const nav = mountNav();
    expect(nav.nativeBorderless()).toBe(true);
    expect(nav.windowControls()).toBe(true);
    const service = {
      current: vi.fn(async () => ({
        useBorderless: true,
        appliedUseBorderless: false,
        restartRequired: true,
        loadFailed: false,
      })),
      save: vi.fn(async () => ({
        useBorderless: true,
        appliedUseBorderless: false,
        restartRequired: true,
        loadFailed: false,
      })),
    };
    const appearance = new WindowAppearanceSession(service);
    await appearance.start();
    expect(nav.nativeBorderless()).toBe(false);
    expect(nav.windowControls()).toBe(false);
    await appearance.save(true);
    expect(nav.windowControls()).toBe(false);
    appearance.dispose();
    expect(nav.windowControls()).toBe(true);
  });
  it("releases local artwork synchronously before main lifecycle teardown", async () => {
    const artwork = { dispose: vi.fn() };
    mocks.artwork = artwork;
    const nav = mountNav();
    await flush();
    nav.service.teardown.mockImplementation(async () => {
      expect(artwork.dispose).toHaveBeenCalledOnce();
    });
    nav.unmount();
    expect(artwork.dispose).toHaveBeenCalledOnce();
    await flush();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
  });
  it("releases local artwork when native Ready rejects", async () => {
    const artwork = { dispose: vi.fn() };
    mocks.artwork = artwork;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const nav = mountNav({ ready: Promise.reject(new Error("fixture ready")) });
    await flush();
    expect(artwork.dispose).toHaveBeenCalledOnce();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
  });
  it("只在主壳Ready后启动更新，待回执期间不阻塞播放接线，卸载立即处置", async () => {
    let release!: () => void;
    const ready = new Promise<{ trayAvailable: boolean; epoch: number }>((resolve) => {
      release = () => resolve({ trayAvailable: true, epoch: 1 });
    });
    const updates = {
      start: vi.fn(() => new Promise<void>(() => {})),
      dispose: vi.fn(async () => {}),
    };
    mocks.updates = updates;
    const nav = mountNav({ ready });
    await flush();
    expect(updates.start).not.toHaveBeenCalled();
    release();
    await flush();
    expect(updates.start).toHaveBeenCalledOnce();
    expect(nav.service.syncPlayback).toHaveBeenCalled();
    nav.unmount();
    expect(updates.dispose).toHaveBeenCalledOnce();
    await flush();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
  });
  it("先安装事件再ready，原生关闭显示后ack，取消保留窗口且后续可再次提示", async () => {
    const nav = mountNav();
    await flush();
    expect(nav.closeHandlers.size).toBe(1);
    expect(nav.actions.size).toBe(1);
    nav.close();
    expect(nav.modal().value).toBe(true);
    expect(nav.service.acknowledgeClose).not.toHaveBeenCalled();
    await flush();
    expect(nav.service.acknowledgeClose).toHaveBeenCalledWith(1);
    nav.modal().value = false;
    await flush();
    expect(nav.service.resolveClose).toHaveBeenCalledWith(1, "cancel");
    nav.close(2);
    await flush();
    expect(nav.modal().value).toBe(true);
    expect(nav.service.acknowledgeClose).toHaveBeenCalledTimes(2);
  });
  it.each(["hide", "exit"] as const)("记住%s先保存设置，只resolve一次", async (action) => {
    const nav = mountNav();
    await flush();
    nav.close();
    await flush();
    nav.remember().value = true;
    nav.choose(action);
    nav.choose(action);
    await flush();
    expect(mocks.setting.closeAppMethod).toBe(action);
    expect(mocks.setting.showCloseAppTip).toBe(false);
    expect(nav.service.resolveClose).toHaveBeenCalledExactlyOnceWith(1, action);
    expect(nav.service.syncConfig).toHaveBeenCalledOnce();
  });
  it("仅设置/播放/歌曲同步，时钟不IPC；动作各一次，卸载teardown先于off", async () => {
    const nav = mountNav();
    await flush();
    expect(nav.service.syncPlayback).toHaveBeenCalledExactlyOnceWith({
      epoch: 1,
      revision: 1,
      trackKey: JSON.stringify(["synthetic", "synthetic"]),
      playing: false,
      hasSong: true,
      liked: false,
      canFavorite: false,
      canSetMode: true,
      playMode: "repeat",
    });
    mocks.status.currentTime = 9000;
    mocks.status.lyricClock = 9000;
    await flush();
    expect(nav.service.syncPlayback).toHaveBeenCalledOnce();
    mocks.status.playStatus = true;
    await flush();
    expect(nav.service.syncPlayback).toHaveBeenCalledTimes(2);
    nav.action("toggle");
    nav.action("previous");
    nav.action("next");
    await flush();
    expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
    expect(mocks.player.nextOrPrev.mock.calls).toEqual([["prev"], ["next"]]);
    nav.service.teardown.mockImplementation(async () => {
      expect(nav.closeHandlers.size).toBe(1);
      expect(nav.actions.size).toBe(1);
    });
    nav.unmount();
    await flush();
    expect(nav.closeHandlers.size).toBe(0);
    expect(nav.actions.size).toBe(0);
    nav.action("toggle");
    expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
  });
  it("ready未完成卸载，迟到ready后teardown，不同步旧状态", async () => {
    let done!: (value: { trayAvailable: boolean; epoch: number }) => void;
    const nav = mountNav({
      ready: new Promise((resolve) => {
        done = resolve;
      }),
    });
    await flush();
    nav.unmount();
    done({ trayAvailable: true, epoch: 1 });
    await flush();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
    expect(nav.service.syncPlayback).not.toHaveBeenCalled();
    expect(nav.closeHandlers.size).toBe(0);
  });
  it("播放拒绝受控，无本地歌曲调用，失效ack关闭提示", async () => {
    const nav = mountNav();
    await flush();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.player.playOrPause.mockRejectedValueOnce(new Error("synthetic"));
    nav.action("toggle");
    await flush();
    expect(window.$message.error).toHaveBeenCalledOnce();
    mocks.music.playSong = { id: "local", path: "/synthetic" };
    nav.action("next");
    await flush();
    expect(mocks.player.nextOrPrev).not.toHaveBeenCalled();
    nav.service.acknowledgeClose.mockRejectedValueOnce(new Error("expired"));
    nav.close();
    await flush();
    expect(nav.modal().value).toBe(false);
    expect(nav.service.resolveClose).not.toHaveBeenCalled();
  });
  it("Ready后启动歌词，失败不撤销媒体文件；卸载同步失效先于lifecycle teardown", async () => {
    let ready!: (value: { trayAvailable: boolean; epoch: number }) => void;
    const media = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const files = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const lyrics = {
      start: vi.fn(async () => {
        expect(media.start).toHaveBeenCalledOnce();
        throw new Error("synthetic lyrics failure");
      }),
      dispose: vi.fn(async () => {}),
    };
    mocks.lyrics = lyrics;
    mocks.media = media;
    mocks.files = files;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const nav = mountNav({
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
    });
    await flush();
    expect(lyrics.start).not.toHaveBeenCalled();
    ready({ trayAvailable: true, epoch: 1 });
    await flush();
    expect(lyrics.start).toHaveBeenCalledOnce();
    expect(files.start).toHaveBeenCalledOnce();
    expect(media.dispose).not.toHaveBeenCalled();
    expect(files.dispose).not.toHaveBeenCalled();
    expect(nav.service.teardown).not.toHaveBeenCalled();
    expect(nav.service.syncPlayback).toHaveBeenCalledOnce();
    nav.unmount();
    expect(lyrics.dispose).toHaveBeenCalledOnce();
    expect(nav.service.teardown).not.toHaveBeenCalled();
    await flush();
    expect(media.dispose).toHaveBeenCalledOnce();
    expect(files.dispose).toHaveBeenCalledOnce();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
  });

  it("歌词尚未启动即卸载，迟到Ready不启动已失效歌词会话", async () => {
    let ready!: (value: { trayAvailable: boolean; epoch: number }) => void;
    const lyrics = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    mocks.lyrics = lyrics;
    const nav = mountNav({
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
    });
    await flush();
    nav.unmount();
    expect(lyrics.dispose).toHaveBeenCalledOnce();
    ready({ trayAvailable: true, epoch: 1 });
    await flush();
    expect(lyrics.start).not.toHaveBeenCalled();
    expect(nav.service.teardown).toHaveBeenCalledOnce();
  });
  it("歌词显示标记跟随原生确认，bounds和播放时钟不反复写入标记", async () => {
    const windowState: LyricsWindowState = {
      epoch: 4,
      revision: 1,
      visible: false,
      pending: false,
      locked: false,
      hoverUnlock: false,
      bounds: { x: 0, y: 0, width: 800, height: 180 },
      failure: "",
    };
    const provider: PlatformDesktopLyrics = {
      begin: async () => ({ epoch: 4 }),
      publishSnapshot: async () => {},
      publishClock: async () => {},
      getState: async () => windowState,
      setVisible: async () => ({ ...windowState, revision: 2, pending: true }),
      attach: async () => ({ window: windowState, snapshot: null }),
      setBounds: async () => windowState,
      setLocked: async (_epoch, locked) => ({ ...windowState, revision: 2, locked }),
      close: async () => windowState,
      command: async () => {},
      teardown: async () => {},
      onWindow: () => () => {},
      onCommand: () => () => {},
      onSnapshot: () => () => {},
      onClock: () => () => {},
    };
    const session = new DesktopLyricsSession(provider, {
      trackKey: () => "synthetic",
      snapshotDependencies: () => [],
      clockDependencies: () => [],
      snapshot: () => ({
        trackKey: "synthetic",
        playName: "Song",
        artistName: "Artist",
        playing: false,
        positionMs: 0,
        offsetMs: 0,
        rate: 1,
        loading: false,
        lrcData: [],
        yrcData: [],
      }),
      clock: () => ({
        trackKey: "synthetic",
        playing: false,
        positionMs: 0,
        offsetMs: 0,
        rate: 1,
      }),
      onSeek: () => () => {},
      execute: () => {},
    });
    mocks.lyrics = session;
    const nav = mountNav();
    await flush();
    expect(mocks.status.showDesktopLyric).toBe(false);
    await session.requestVisible(true);
    expect(mocks.status.showDesktopLyric).toBe(false);
    let visible = false;
    const writes = vi.fn((value: boolean) => {
      visible = value;
    });
    Object.defineProperty(mocks.status, "showDesktopLyric", {
      configurable: true,
      get: () => visible,
      set: writes,
    });
    session.acceptWindow({ ...windowState, revision: 3, visible: true });
    expect(mocks.status.showDesktopLyric).toBe(true);
    expect(writes).toHaveBeenCalledExactlyOnceWith(true);
    for (let revision = 4; revision < 24; revision++) {
      session.acceptWindow({
        ...windowState,
        revision,
        visible: true,
        bounds: { ...windowState.bounds, x: revision },
      });
      mocks.status.currentTime = revision;
      mocks.status.lyricClock = revision;
    }
    await flush();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(nav.service.syncPlayback).toHaveBeenCalledOnce();
    session.acceptWindow({ ...windowState, revision: 24, visible: false });
    expect(mocks.status.showDesktopLyric).toBe(false);
    expect(writes).toHaveBeenLastCalledWith(false);
    nav.unmount();
    await flush();
  });
  it("托盘设置不依赖歌曲，卸载后的迟到导入不会打开设置", async () => {
    mocks.openSetting.mockClear();
    const nav = mountNav();
    await flush();
    mocks.music.playSong = { id: "", path: "" };
    await flush();
    nav.action("open-settings");
    await vi.dynamicImportSettled();
    await flush();
    expect(mocks.openSetting).toHaveBeenCalledOnce();
    expect(mocks.player.playOrPause).not.toHaveBeenCalled();
    expect(mocks.player.nextOrPrev).not.toHaveBeenCalled();
    nav.unmount();
    await flush();
    mocks.openSetting.mockClear();
    const next = mountNav();
    await flush();
    next.action("open-settings");
    next.unmount();
    await vi.dynamicImportSettled();
    await flush();
    expect(mocks.openSetting).not.toHaveBeenCalled();
  });
});
