import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import type { PlatformAdapter } from "./types";
import type { PlatformSystemMedia } from "./systemMedia";
import type { SystemMediaCommand } from "./mygo.bindings";

const mocks = vi.hoisted(() => ({
  platform: {} as PlatformAdapter,
  data: { playList: [] as unknown[] },
  player: {
    getSeek: vi.fn(() => 0),
    onSeek: vi.fn<(listener: () => void) => () => void>(),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    nextOrPrev: vi.fn<(direction: string) => Promise<void>>().mockResolvedValue(undefined),
    setSeek: vi.fn(),
  },
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/env", () => ({ isElectron: false, isMygo: true, isMac: true }));
vi.mock("@/utils/format", () => ({ getSizeCover: vi.fn() }));
vi.mock("@/utils/blob", () => ({ default: {} }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/utils/helper", () => ({ shuffleArray: vi.fn(), renderOption: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  ...(await import("@/stores/status")),
  ...(await import("@/stores/music")),
  useDataStore: () => mocks.data,
}));
vi.stubGlobal("localStorage", {});
const { useSettingStore, useStatusStore, useMusicStore } = await import("@/stores");
const { useDesktopLifecycle } = await import("@/composables/useDesktopLifecycle");
const { usePlaySettings } = await import("@/components/Setting/config/play");
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await Vue.nextTick();
};
const unmounts: Array<() => void> = [];
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("window", { $message: { error: vi.fn() } });
  mocks.data = Vue.reactive({ playList: [{}] });
  mocks.player.getSeek.mockReturnValue(0);
});
afterEach(async () => {
  unmounts.splice(0).forEach((off) => off());
  await flush();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  ready: Promise<{ trayAvailable: boolean }> = Promise.resolve({ trayAvailable: true }),
) {
  const order: string[] = [];
  let generation = 0;
  const commands = new Set<(command: SystemMediaCommand) => void>();
  const seeks = new Set<() => void>();
  const provider: PlatformSystemMedia = {
    configure: vi.fn(async (_generation, mediaEnabled, preventSleep) => {
      order.push("configure");
      return {
        generation: ++generation,
        mediaEnabled,
        metadataRequested: false,
        keepAwakeRequested: preventSleep,
      };
    }),
    set: vi.fn(async () => {}),
    setPlayback: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {
      order.push("media-teardown");
    }),
    onCommand: (listener) => {
      order.push("media-subscribe");
      commands.add(listener);
      return () => {
        order.push("media-off");
        commands.delete(listener);
      };
    },
  };
  mocks.player.onSeek.mockImplementation((listener) => {
    seeks.add(listener);
    return () => {
      seeks.delete(listener);
    };
  });
  const lifecycle = {
    ready: vi.fn(() => {
      order.push("ready");
      return ready;
    }),
    teardown: vi.fn(async () => {
      order.push("lifecycle-teardown");
    }),
    syncConfig: vi.fn(async () => {}),
    syncPlayback: vi.fn(async () => {}),
    acknowledgeClose: vi.fn(),
    resolveClose: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    quit: vi.fn(),
    onCloseRequested: () => () => {},
    onTrayAction: () => () => {},
  };
  Object.assign(mocks.platform, {
    kind: "mygo",
    os: "linux",
    capabilities: { tray: true, windowControls: false },
    systemMedia: provider,
    lifecycle,
    shortcuts: undefined,
  });
  const music = useMusicStore();
  music.playSong = {
    ...music.playSong,
    id: "fixture",
    platform: "synthetic",
    name: "Synthetic track",
    artists: [{ id: "artist", name: "Synthetic artist" }],
    album: "Synthetic album",
  };
  const status = useStatusStore();
  status.duration = 10000;
  const setting = useSettingStore();
  const emit = (action: string, positionMs = 0, patch: Partial<SystemMediaCommand> = {}) => {
    const calls = vi.mocked(provider.set).mock.calls;
    const [gen, revision, track] = calls[calls.length - 1];
    commands.forEach((callback) =>
      callback({ generation: gen, revision, trackId: track.id, action, positionMs, ...patch }),
    );
  };
  return { order, provider, lifecycle, music, setting, status, commands, seeks, emit };
}

// Compile and execute the actual Nav script setup; host rendering is deliberately minimal.
function mountNav() {
  const source = readFileSync(
    new URL("../components/Layout/Nav.vue", import.meta.url),
    "utf8",
  ).replace(
    '<script setup lang="ts">',
    '<script setup lang="ts">\nimport { computed } from "vue";\nconst useRouter = () => ({});',
  );
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: "Nav.vue" });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/stores": { useSettingStore },
    "@/platform": { platform: mocks.platform },
    "@/utils/helper": {},
    "@/utils/env": { isElectron: false, isMac: true },
    "@/utils/modal": {},
    "@/constants/links": {},
    "@/composables/useMobile": {
      useMobile: () => ({ isDesktop: Vue.ref(true), isSmallScreen: Vue.ref(false) }),
    },
    "@/composables/useDesktopLifecycle": { useDesktopLifecycle },
    "@/components/Layout/Menu.vue": {},
    "@/components/Layout/Logo.vue": {},
  };
  const exports: { default?: { setup: (props: object, ctx: object) => unknown } } = {};
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, exports);
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
      exports.default!.setup({}, { expose() {} });
      return () => null;
    },
  });
  app.mount({});
  const unmount = () => app.unmount();
  unmounts.push(unmount);
  return unmount;
}

describe("Nav system media shell with actual Pinia stores", () => {
  it("subscribes before Ready, preserves defaults, and exposes only the available power setting", async () => {
    let resolveReady: (value: { trayAvailable: boolean }) => void = () => {};
    const f = fixture(
      new Promise((resolve) => {
        resolveReady = resolve;
      }),
    );
    expect(f.setting.smtcOpen).toBe(true);
    expect(f.setting.preventSleep).toBe(false);
    const unmount = mountNav();
    await flush();
    expect(f.order.slice(0, 2)).toEqual(["media-subscribe", "ready"]);
    expect(f.provider.configure).not.toHaveBeenCalled();
    resolveReady({ trayAvailable: true });
    await flush();
    expect(f.provider.configure).toHaveBeenCalledWith(0, true, false);
    expect(
      usePlaySettings()
        .groups.flatMap((group) => group.items)
        .find((item) => item.key === "preventSleep")?.show,
    ).toBe(true);
    unmount();
    await flush();
    expect(f.order.slice(-3)).toEqual(["media-teardown", "media-off", "lifecycle-teardown"]);
    Object.assign(mocks.platform, { systemMedia: undefined });
    expect(
      usePlaySettings()
        .groups.flatMap((group) => group.items)
        .find((item) => item.key === "preventSleep")?.show,
    ).toBe(false);
  });

  it("uses existing Player actions including seek0, clears local/empty songs, and never reacts to clocks", async () => {
    const f = fixture();
    mountNav();
    await flush();
    for (const action of ["play", "pause", "previous", "next", "seek"]) {
      f.emit(action);
      await flush();
    }
    expect(mocks.player.play).toHaveBeenCalledOnce();
    expect(mocks.player.pause).toHaveBeenCalledOnce();
    expect(mocks.player.nextOrPrev.mock.calls).toEqual([["prev"], ["next"]]);
    expect(mocks.player.setSeek).toHaveBeenCalledWith(0);
    const playbackCount = vi.mocked(f.provider.setPlayback).mock.calls.length;
    const seekReads = mocks.player.getSeek.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      f.status.currentTime = i;
      f.status.lyricIndex = i;
      f.status.progress = i;
    }
    await flush();
    expect(f.provider.configure).toHaveBeenCalledOnce();
    expect(f.provider.set).toHaveBeenCalledOnce();
    expect(f.provider.setPlayback).toHaveBeenCalledTimes(playbackCount);
    expect(mocks.player.getSeek).toHaveBeenCalledTimes(seekReads);
    f.status.playStatus = true;
    await flush();
    expect(f.provider.setPlayback).toHaveBeenLastCalledWith(
      1,
      1,
      JSON.stringify(["synthetic", "fixture"]),
      "playing",
      0,
    );
    f.status.playRate = 1.75;
    await flush();
    expect(f.provider.set).toHaveBeenLastCalledWith(1, 2, expect.objectContaining({ rate: 1.75 }));
    f.music.playSong.path = "/synthetic/never-read.wav";
    await flush();
    expect(f.provider.clear).toHaveBeenLastCalledWith(1, 3);
    f.emit("play");
    await flush();
    expect(mocks.player.play).toHaveBeenCalledOnce();
    f.music.playSong = { ...f.music.playSong, path: undefined, id: "" };
    await flush();
    expect(f.provider.set).toHaveBeenCalledTimes(2);
  });

  it("serializes replacement and independently reconfigures media/power; old callbacks stop", async () => {
    const f = fixture();
    const unmount = mountNav();
    await flush();
    const oldCallback = [...f.commands][0];
    f.setting.preventSleep = true;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(1, true, true);
    f.setting.smtcOpen = false;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(2, false, true);
    f.setting.smtcOpen = true;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(3, true, true);
    unmount();
    mountNav();
    oldCallback({
      generation: 4,
      revision: 1,
      trackId: JSON.stringify(["synthetic", "fixture"]),
      action: "play",
      positionMs: 0,
    });
    await flush();
    expect(mocks.player.play).not.toHaveBeenCalled();
    const teardown = f.order.indexOf("lifecycle-teardown");
    expect(f.order.indexOf("ready", teardown)).toBeGreaterThan(teardown);
    expect(f.seeks.size).toBe(1);
    f.setting.preventSleep = false;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(5, true, false);
  });

  it("leaves hosts without a provider on the existing lifecycle path", async () => {
    const f = fixture();
    Object.assign(mocks.platform, { systemMedia: undefined });
    mountNav();
    await flush();
    expect(f.lifecycle.ready).toHaveBeenCalledOnce();
    expect(f.provider.configure).not.toHaveBeenCalled();
    expect(mocks.player.onSeek).not.toHaveBeenCalled();
  });
});
