import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/composables/shellProtocols", () => ({ createShellProtocolSession: () => undefined }));
vi.mock("@/composables/shellTaskbar", () => ({ createShellTaskbarSession: () => undefined }));
import * as Vue from "vue";
import type { PlatformAdapter } from "./types";
import type { GlobalShortcutStatus, PlatformShortcuts } from "./shortcuts";
import type { ShortcutEvent } from "./mygo.bindings";

const mocks = vi.hoisted(() => ({
  platform: {} as PlatformAdapter,
  store: {
    globalOpen: true,
    shortcutList: { volumeUp: { globalShortcut: "Ctrl+Alt+Shift+F19", isRegistered: false } },
  },
  music: { playSong: { id: "fixture", path: "" } },
  status: { playStatus: false, currentTime: 0, lyricClock: 0 },
  setting: { showCloseAppTip: true, closeAppMethod: "hide", language: "zh-CN" },
  player: {
    playOrPause: vi.fn(async () => {}),
    nextOrPrev: vi.fn(async () => {}),
    setVolume: vi.fn(),
  },
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/stores", () => ({
  useShortcutStore: () => mocks.store,
  useMusicStore: () => mocks.music,
  useDataStore: () => ({ userData: { id: "" }, userLoginStatus: false, isLikeSong: () => false }),
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.setting,
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ locale: { value: "zh-CN" }, t: (key: string) => key }),
}));
import { useDesktopLifecycle } from "@/composables/useDesktopLifecycle";
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await Vue.nextTick();
};
const unmounts: Array<() => void> = [];
afterEach(async () => {
  unmounts.splice(0).forEach((off) => off());
  await flush();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
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
      useDesktopLifecycle({ showCloseModal: Vue.ref(false), rememberNotAsk: Vue.ref(false) });
      return () => null;
    },
  });
  app.mount({});
  const unmount = () => app.unmount();
  unmounts.push(unmount);
  return unmount;
}
function configure() {
  mocks.store = Vue.reactive({
    globalOpen: true,
    shortcutList: { volumeUp: { globalShortcut: "Ctrl+Alt+Shift+F19", isRegistered: false } },
  });
  mocks.status = Vue.reactive({ playStatus: false, currentTime: 0, lyricClock: 0 });
  const order: string[] = [];
  let generation = 0;
  const callbacks = new Set<(event: ShortcutEvent) => void>();
  const provider: PlatformShortcuts = {
    actions: ["volumeUp"],
    replace: vi.fn(async (_generation, enabled, bindings) => {
      order.push("replace");
      return {
        generation: ++generation,
        enabled,
        suspended: false,
        results: bindings.map((binding) => ({
          ...binding,
          normalized: "Ctrl+Alt+Shift+F19",
          status: "registered",
          error: "",
        })),
      };
    }),
    suspend: vi.fn(),
    check: vi.fn(),
    teardown: vi.fn(async () => {
      order.push("shortcut-teardown");
    }),
    onAction: (callback) => {
      order.push("subscribe");
      callbacks.add(callback);
      return () => {
        order.push("unsubscribe");
        callbacks.delete(callback);
      };
    },
  };
  const lifecycle = {
    ready: vi.fn(async () => {
      order.push("ready");
      return { trayAvailable: true, epoch: 1 };
    }),
    syncConfig: vi.fn(async () => {}),
    syncPlayback: vi.fn(async () => {}),
    acknowledgeClose: vi.fn(async () => {}),
    resolveClose: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    teardown: vi.fn(async () => {
      order.push("lifecycle-teardown");
    }),
    onCloseRequested: () => () => {},
    onTrayAction: () => () => {},
  };
  Object.assign(mocks.platform, { kind: "mygo", os: "darwin", shortcuts: provider, lifecycle });
  vi.stubGlobal("window", { $message: { error: vi.fn(), warning: vi.fn() } });
  return {
    provider,
    lifecycle,
    order,
    callbacks,
    emit: (generation: number) =>
      callbacks.forEach((callback) => callback({ generation, action: "volumeUp" })),
  };
}

describe("actual application shell shortcut ownership", () => {
  it("订阅先于ready；进度和歌词时钟不注册；卸载先清快捷键再清lifecycle", async () => {
    const f = configure();
    const unmount = mount();
    await flush();
    expect(f.order.slice(0, 3)).toEqual(["subscribe", "ready", "replace"]);
    mocks.status.currentTime++;
    mocks.status.lyricClock++;
    await flush();
    expect(f.provider.replace).toHaveBeenCalledOnce();
    f.emit(1);
    await flush();
    expect(mocks.player.setVolume).toHaveBeenCalledExactlyOnceWith("up");
    unmount();
    f.emit(1);
    await flush();
    expect(mocks.player.setVolume).toHaveBeenCalledOnce();
    expect(f.order.indexOf("shortcut-teardown")).toBeLessThan(
      f.order.indexOf("lifecycle-teardown"),
    );
    expect(f.callbacks.size).toBe(0);
  });
  it("旧注册晚返回时重挂载仍等待旧teardown，新旧回调generation不互串", async () => {
    const f = configure();
    let resolve!: (status: GlobalShortcutStatus) => void;
    vi.mocked(f.provider.replace).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const unmount = mount();
    await flush();
    unmount();
    mount();
    await flush();
    expect(f.lifecycle.ready).toHaveBeenCalledOnce();
    resolve({ generation: 80, enabled: true, suspended: false, results: [] });
    await flush();
    expect(f.provider.teardown).toHaveBeenCalledWith(80);
    expect(f.lifecycle.ready).toHaveBeenCalledTimes(2);
    expect(f.order.indexOf("shortcut-teardown")).toBeLessThan(f.order.lastIndexOf("ready"));
    expect(f.callbacks.size).toBe(1);
    f.emit(80);
    expect(mocks.player.setVolume).not.toHaveBeenCalled();
    f.emit(1);
    await flush();
    expect(mocks.player.setVolume).toHaveBeenCalledOnce();
  });
  it("Web无provider不调用native；Electron仍共享壳的挂载与注销", async () => {
    const f = configure();
    Object.assign(mocks.platform, { kind: "web", lifecycle: undefined, shortcuts: undefined });
    const off = mount();
    await flush();
    expect(f.provider.replace).not.toHaveBeenCalled();
    off();
    await flush();
    Object.assign(mocks.platform, { kind: "electron", shortcuts: f.provider });
    const electronOff = mount();
    await flush();
    expect(f.provider.replace).toHaveBeenCalledOnce();
    electronOff();
    await flush();
    expect(f.provider.teardown).toHaveBeenCalledOnce();
  });
});
