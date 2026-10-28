import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import { useDebounceFn, useThrottleFn } from "@vueuse/core";
import ts from "typescript";
import { calculateLyricIndex } from "@/utils/calc";
import defaultConfig from "@/assets/data/lyricConfig";
import type { LyricConfig, LyricData, RenderLine } from "@/types/desktop-lyric";
import type {
  LyricsAttachment,
  LyricsBounds,
  LyricsClock,
  LyricsSnapshot,
  LyricsWindowState,
  PlatformDesktopLyrics,
} from "@/platform/desktopLyrics";
import { createDesktopLyricsConsumer } from "./desktopLyricsConsumer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function windowState(revision = 1, epoch = 7): LyricsWindowState {
  return {
    epoch,
    revision,
    visible: true,
    pending: false,
    locked: false,
    hoverUnlock: false,
    bounds: { x: 100, y: 200, width: 800, height: 180 },
    failure: "",
  };
}
function snapshot(seq = 1, trackKey = "A", epoch = 7): LyricsSnapshot {
  const line = {
    words: [
      { startTime: 0, endTime: 1500, word: "声", romanWord: "koe" },
      { startTime: 1500, endTime: 3000, word: "音", romanWord: "oto" },
    ],
    translatedLyric: "声音译文",
    romanLyric: "koe oto",
    isBG: true,
    isDuet: true,
    startTime: 0,
    endTime: 3000,
  };
  return {
    epoch,
    seq,
    trackKey,
    playName: `Song ${trackKey}`,
    artistName: "Singer",
    playing: true,
    positionMs: 1000,
    offsetMs: -100,
    rate: 1.5,
    loading: false,
    lrcData: [line],
    yrcData: [line],
  };
}
function clock(seq = 2, trackKey = "A", epoch = 7): LyricsClock {
  return { epoch, seq, trackKey, playing: true, positionMs: 1100, offsetMs: -100, rate: 1.5 };
}
function providerFixture() {
  const attachment = deferred<LyricsAttachment>();
  const order: string[] = [];
  const snapshots = new Set<(value: LyricsSnapshot) => void>();
  const clocks = new Set<(value: LyricsClock) => void>();
  const windows = new Set<(value: LyricsWindowState) => void>();
  const off = [vi.fn(), vi.fn(), vi.fn()];
  const provider = {
    attach: vi.fn(() => {
      order.push("attach");
      return attachment.promise;
    }),
    onSnapshot: (handler: (value: LyricsSnapshot) => void) => {
      order.push("snapshot");
      snapshots.add(handler);
      return () => {
        snapshots.delete(handler);
        off[0]();
      };
    },
    onClock: (handler: (value: LyricsClock) => void) => {
      order.push("clock");
      clocks.add(handler);
      return () => {
        clocks.delete(handler);
        off[1]();
      };
    },
    onWindow: (handler: (value: LyricsWindowState) => void) => {
      order.push("window");
      windows.add(handler);
      return () => {
        windows.delete(handler);
        off[2]();
      };
    },
    getState: vi.fn(async () => windowState(2)),
    setBounds: vi.fn(async (_epoch: number, bounds: LyricsBounds) => ({
      ...windowState(2),
      bounds,
    })),
    close: vi.fn(async () => ({ ...windowState(3), visible: false })),
    command: vi.fn<PlatformDesktopLyrics["command"]>().mockResolvedValue(undefined),
  };
  return {
    provider,
    attachment,
    order,
    off,
    snapshots,
    clocks,
    windows,
    emitSnapshot: (value: LyricsSnapshot) => snapshots.forEach((handler) => handler(value)),
    emitClock: (value: LyricsClock) => clocks.forEach((handler) => handler(value)),
    emitWindow: (value: LyricsWindowState) => windows.forEach((handler) => handler(value)),
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await Vue.nextTick();
};

class HostNode {
  children: HostNode[] = [];
  parent: HostNode | null = null;
  props: Record<string, unknown> = {};
  text = "";
  clientWidth = 800;
  scrollWidth = 800;
  constructor(readonly tag: string) {}
}
interface ViewState {
  lyricData: LyricData;
  lyricConfig: LyricConfig;
  playSeekMs: Vue.Ref<number>;
  renderLyricLines: Vue.ComputedRef<RenderLine[]>;
  isInitializing: Vue.Ref<boolean>;
  consumer: ReturnType<typeof createDesktopLyricsConsumer>;
  cachedBounds: LyricsBounds;
  sendToMain: (event: string, ...args: unknown[]) => void;
  sendToMainWin: (event: string, ...args: unknown[]) => void;
  toggleLyricLock: () => void;
  tempToggleLyricLock: (lock: boolean) => void;
  onDocPointerDown: (event: PointerEvent) => void;
  onDocPointerMove: (event: PointerEvent) => void;
  onDocPointerUp: () => void;
  debouncedSaveConfig: (size: number) => void;
  lineRefs: Map<string, HTMLElement>;
  contentRefs: Map<string, HTMLElement>;
}
const cleanups: Array<() => void> = [];
let now = 50000;
let frameId = 0;
let frames: Map<number, FrameRequestCallback>;
let docListeners: Map<string, Set<EventListener>>;
let hostWindow: Record<string, unknown>;
let rafCallbacks: Set<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  now = 50000;
  frames = new Map();
  rafCallbacks = new Set();
  docListeners = new Map();
  hostWindow = {};
  Object.defineProperties(hostWindow, {
    electron: {
      configurable: true,
      get: () => {
        throw new Error("Electron global read");
      },
    },
    api: {
      configurable: true,
      get: () => {
        throw new Error("Electron API read");
      },
    },
  });
  vi.stubGlobal("window", hostWindow);
  vi.stubGlobal("document", {
    addEventListener: (name: string, handler: EventListener) => {
      if (!docListeners.has(name)) docListeners.set(name, new Set());
      docListeners.get(name)?.add(handler);
    },
    removeEventListener: (name: string, handler: EventListener) => {
      docListeners.get(name)?.delete(handler);
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function tick(ms: number) {
  now += ms;
  rafCallbacks.forEach((callback) => callback());
}
function pointer(x: number, y: number): PointerEvent {
  return {
    button: 0,
    screenX: x,
    screenY: y,
    target: { closest: () => null },
    preventDefault() {},
  } as unknown as PointerEvent;
}
function allNodes(root: HostNode): HostNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}
function text(root: HostNode): string {
  return root.text + root.children.map(text).join("");
}
function mountView(kind: "mygo" | "electron" | "web", fixture = providerFixture()) {
  const size = { width: Vue.ref(800), height: Vue.ref(180) };
  const autoImports = {
    ref: Vue.ref,
    reactive: Vue.reactive,
    computed: Vue.computed,
    watch: Vue.watch,
    onMounted: Vue.onMounted,
    onBeforeUnmount: Vue.onBeforeUnmount,
    useWindowSize: () => size,
    useDebounceFn,
    useThrottleFn,
    useRafFn: (callback: () => void) => {
      const pause = () => rafCallbacks.delete(callback);
      const resume = () => rafCallbacks.add(callback);
      resume();
      Vue.onScopeDispose(pause);
      return { pause, resume };
    },
    useTimeoutFn: (callback: () => void, delay: number, options?: { immediate?: boolean }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => clearTimeout(timer);
      const start = () => {
        stop();
        timer = setTimeout(callback, delay);
      };
      if (options?.immediate !== false) start();
      Vue.onScopeDispose(stop);
      return { start, stop };
    },
  };
  const source = readFileSync(new URL("./index.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "DesktopLyric" });
  const template = compileTemplate({
    id: "DesktopLyric",
    source: descriptor.template!.content,
    filename: "index.vue",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const passthrough = Vue.defineComponent({
    setup(_props, { slots }) {
      return () => Vue.h("section", slots.default?.());
    },
  });
  const modules: Record<string, unknown> = {
    vue: { ...Vue, TransitionGroup: passthrough },
    "@/utils/calc": { calculateLyricIndex },
    "@/assets/data/lyricConfig": { default: defaultConfig },
    "@/platform": {
      platform: { kind, desktopLyrics: kind === "mygo" ? fixture.provider : undefined },
    },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "./desktopLyricsConsumer": { createDesktopLyricsConsumer },
  };
  const code = ts.transpileModule(script.content + "\n" + template.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: {
    default?: { setup: (props: object, context: object) => ViewState };
    render?: Vue.ComponentOptions["render"];
  } = {};
  new Function("require", "exports", ...Object.keys(autoImports), code)(
    (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
    exports,
    ...Object.values(autoImports),
  );
  let state!: ViewState;
  const renderer = Vue.createRenderer<HostNode, HostNode>({
    createElement: (tag) => new HostNode(tag),
    createText: (value) => Object.assign(new HostNode("text"), { text: value }),
    createComment: () => new HostNode("comment"),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = null;
    },
    setText: (node, value) => {
      node.text = value;
    },
    setElementText: (node, value) => {
      node.text = value;
      node.children = [];
    },
    patchProp: (node, key, _old, value) => {
      node.props[key] = value;
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => {
      const siblings = node.parent?.children ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
  });
  const app = renderer.createApp({
    setup(props, context) {
      state = exports.default!.setup(props, context);
      return state;
    },
    render: exports.render,
  });
  app.component("NConfigProvider", passthrough);
  app.component("NFlex", passthrough);
  app.component("SvgIcon", Vue.defineComponent({ props: ["name"], setup: () => () => null }));
  const root = new HostNode("root");
  app.mount(root);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
  };
  cleanups.push(unmount);
  return { state, root, unmount, fixture, size };
}

describe("DesktopLyric production SFC", () => {
  it("mygo首次挂载无Electron访问，先三订阅再Attach，真实模板显示逐字/译文", async () => {
    const view = mountView("mygo");
    expect(view.fixture.order).toEqual(["snapshot", "clock", "window", "attach"]);
    expect(text(view.root)).toContain("message.desktop_lyrics_connecting");
    vi.advanceTimersByTime(2000);
    expect(view.state.isInitializing.value).toBe(true);
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await flush();
    expect(view.state.lyricData.yrcData).toEqual(snapshot().yrcData);
    expect(text(view.root)).toContain("Song A");
    expect(text(view.root)).toContain("声音译文");
    expect(text(view.root)).toContain("声");
    expect(
      allNodes(view.root).filter((node) => node.props.class === "menu-btn lock-btn"),
    ).toHaveLength(0);
    expect(view.state.lyricConfig.font).not.toBe(defaultConfig.font);
    view.state.lyricConfig.font.size = 40;
    await flush();
    expect(defaultConfig.font.size).toBe(24);
    expect(view.fixture.provider.setBounds).not.toHaveBeenCalled();
  });

  it("晚Attach不覆盖事件新曲、clock、revision，快照完整替换歌词", async () => {
    const view = mountView("mygo");
    view.fixture.emitSnapshot(snapshot(8, "B"));
    view.fixture.emitClock({ ...clock(10, "B"), positionMs: 2200 });
    view.fixture.emitWindow({ ...windowState(9), bounds: { x: 9, y: 8, width: 700, height: 200 } });
    view.fixture.attachment.resolve({ window: windowState(1), snapshot: snapshot(2, "A") });
    await flush();
    expect(view.state.lyricData.playName).toBe("Song B");
    expect(view.state.playSeekMs.value).toBe(2100);
    expect(view.state.cachedBounds.x).toBe(9);
    view.fixture.emitSnapshot({ ...snapshot(11, "C"), lrcData: [], yrcData: [] });
    expect(view.state.lyricData.playName).toBe("Song C");
    expect(view.state.lyricData.lrcData).toEqual([]);
    expect(view.state.lyricData.yrcData).toEqual([]);
    view.fixture.emitClock({ ...clock(99, "B"), positionMs: 9000 });
    view.fixture.emitClock({ ...clock(10, "C"), positionMs: 9000 });
    view.fixture.emitSnapshot(snapshot(99, "old", 6));
    expect(view.state.playSeekMs.value).toBe(900);
    view.fixture.emitSnapshot(snapshot(1, "D", 8));
    expect(view.state.lyricData.playName).toBe("Song D");
    view.fixture.emitWindow(windowState(100, 7));
    expect(view.state.consumer.windowState.value).toBeUndefined();
  });

  it("毫秒/rate推进，小seek、暂停、速率和切歌立即在接收时刻重锚", async () => {
    const view = mountView("mygo");
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await flush();
    expect(view.state.playSeekMs.value).toBe(900);
    tick(100);
    expect(view.state.playSeekMs.value).toBe(1050);
    view.fixture.emitClock({ ...clock(2), positionMs: 1100, rate: 2 });
    expect(view.state.playSeekMs.value).toBe(1000);
    tick(20);
    expect(view.state.playSeekMs.value).toBe(1040);
    view.fixture.emitClock({ ...clock(3), positionMs: 1110, playing: false });
    expect(view.state.playSeekMs.value).toBe(1010);
    tick(1000);
    expect(view.state.playSeekMs.value).toBe(1010);
    view.fixture.emitClock({ ...clock(4), positionMs: 1090, rate: 0.5 });
    tick(100);
    expect(view.state.playSeekMs.value).toBe(1040);
    view.fixture.emitSnapshot({ ...snapshot(5, "B"), positionMs: 10, offsetMs: 5, rate: 1 });
    expect(view.state.playSeekMs.value).toBe(15);
    tick(10);
    expect(view.state.playSeekMs.value).toBe(25);
  });

  it("模板header五固定命令与Close走子页provider，拒绝任意native IPC和锁", async () => {
    const view = mountView("mygo");
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await flush();
    const buttons = allNodes(view.root).filter((node) => node.props.class === "menu-btn");
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      const click = button.props.onClick as (event: { stopPropagation: () => void }) => void;
      click({ stopPropagation() {} });
    }
    await flush();
    expect(view.fixture.provider.command.mock.calls.map(([value]) => value)).toEqual([
      { epoch: 7, trackKey: "A", action: "show-main" },
      { epoch: 7, trackKey: "A", action: "previous" },
      { epoch: 7, trackKey: "A", action: "toggle" },
      { epoch: 7, trackKey: "A", action: "next" },
      { epoch: 7, trackKey: "A", action: "open-settings" },
    ]);
    expect(view.fixture.provider.close).toHaveBeenCalledExactlyOnceWith(7);
    view.state.sendToMain("begin");
    view.state.sendToMain("open-setting", "other");
    view.state.sendToMainWin("arbitrary");
    view.state.toggleLyricLock();
    view.state.tempToggleLyricLock(true);
    expect(view.state.lyricConfig.isLock).toBe(false);
    expect(view.fixture.provider.command).toHaveBeenCalledTimes(5);
  });

  it("生产拖动使用受控bounds及native实际revision，排队release帧卸载取消", async () => {
    const view = mountView("mygo");
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await flush();
    const response = deferred<LyricsWindowState>();
    view.fixture.provider.setBounds.mockImplementation(() => response.promise);
    view.state.onDocPointerDown(pointer(10, 20));
    view.state.onDocPointerMove(pointer(30, 40));
    expect(view.fixture.provider.setBounds).toHaveBeenCalledWith(7, {
      x: 120,
      y: 220,
      width: 800,
      height: 180,
    });
    expect(view.state.cachedBounds.x).toBe(100);
    view.fixture.emitWindow({
      ...windowState(5),
      bounds: { x: 111, y: 222, width: 790, height: 190 },
    });
    response.resolve({ ...windowState(3), bounds: { x: 120, y: 220, width: 800, height: 180 } });
    await flush();
    expect(view.state.cachedBounds.x).toBe(111);
    view.state.onDocPointerUp();
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    expect([...docListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(rafCallbacks.size).toBe(0);
    expect(view.state.lineRefs.size).toBe(0);
    expect(view.state.contentRefs.size).toBe(0);
    vi.runAllTimers();
    await flush();
    expect(view.fixture.provider.setBounds).toHaveBeenCalledTimes(1);
    expect(view.fixture.off.every((off) => off.mock.calls.length === 1)).toBe(true);
  });

  it("普通Web安全失败，Attach null仅连接无歌词，失败不被2秒fallback遮盖", async () => {
    const web = mountView("web");
    await flush();
    expect(text(web.root)).toContain("message.desktop_lyrics_connection_failed");
    expect(web.fixture.order).toEqual([]);
    expect([...docListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    web.unmount();
    const native = mountView("mygo");
    native.fixture.attachment.resolve({ window: windowState(), snapshot: null });
    await flush();
    expect(native.state.consumer.status.value).toBe("connected");
    expect(text(native.root)).toContain("message.desktop_lyrics_not_ready");
    native.fixture.emitWindow({ ...windowState(2), failure: "native-failed", visible: false });
    vi.advanceTimersByTime(2000);
    await flush();
    expect(text(native.root)).toContain("message.desktop_lyrics_connection_failed");
  });

  it("卸载前Attach未回与排队debounce不复活，迟到事件/窗口回执无效果", async () => {
    const view = mountView("mygo");
    const lateSnapshot = [...view.fixture.snapshots][0];
    view.state.debouncedSaveConfig(42);
    view.unmount();
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    lateSnapshot(snapshot(99));
    vi.runAllTimers();
    await flush();
    expect(view.state.isInitializing.value).toBe(true);
    expect(view.state.consumer.status.value).toBe("connecting");
    expect(view.fixture.provider.setBounds).not.toHaveBeenCalled();
    expect(view.fixture.provider.command).not.toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(0);
    expect(view.fixture.snapshots.size + view.fixture.clocks.size + view.fixture.windows.size).toBe(
      0,
    );
  });

  it("Electron保留旧IPC/config/时钟/2秒fallback并精确退订，首次字体watch可发送", async () => {
    const handlers = new Map<string, (event: unknown, value: unknown) => void>();
    const off = [vi.fn(), vi.fn()];
    const send = vi.fn();
    const invoke = vi.fn(async (name: string) =>
      name === "get-window-bounds" ? { x: 3, y: 4 } : {},
    );
    Object.defineProperty(hostWindow, "electron", {
      value: {
        ipcRenderer: {
          send,
          invoke,
          on: (name: string, handler: (event: unknown, value: unknown) => void) => {
            const index = handlers.size;
            handlers.set(name, handler);
            return () => {
              handlers.delete(name);
              off[index]();
            };
          },
        },
      },
    });
    Object.defineProperty(hostWindow, "api", {
      value: { store: { get: vi.fn(async () => ({ width: 810, height: 190 })) } },
    });
    const view = mountView("electron");
    expect(send).toHaveBeenCalledWith("update-window-height", expect.any(Number));
    expect(send).toHaveBeenCalledWith("request-desktop-lyric-data");
    expect(invoke).toHaveBeenCalledWith("request-desktop-lyric-option");
    expect(view.fixture.provider.attach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    await flush();
    expect(view.state.isInitializing.value).toBe(false);
    handlers.get("update-desktop-lyric-data")?.(null, {
      playName: "Electron song",
      currentTime: 1000,
      songOffset: 20,
      playStatus: true,
    });
    tick(10);
    expect(view.state.playSeekMs.value).toBe(1030);
    const config = { ...defaultConfig, isLock: true, font: { ...defaultConfig.font, size: 30 } };
    handlers.get("update-desktop-lyric-option")?.(null, config);
    expect(view.state.lyricConfig.isLock).toBe(true);
    view.state.sendToMainWin("playNext");
    expect(send).toHaveBeenCalledWith("send-to-mainWin", "playNext");
    expect(send).toHaveBeenCalledWith("toggleDesktopLyricLock", { lock: true });
    view.state.debouncedSaveConfig(44);
    const sends = send.mock.calls.length;
    view.unmount();
    vi.runAllTimers();
    expect(send).toHaveBeenCalledTimes(sends);
    expect(off.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(handlers.size).toBe(0);
  });
  it("先到跨曲clock保留到对应完整快照，晚Attach不丢B10", async () => {
    const view = mountView("mygo");
    view.fixture.emitClock({ ...clock(10, "B"), positionMs: 2400 });
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot(5, "A") });
    await flush();
    view.fixture.emitSnapshot(snapshot(8, "B"));
    expect(view.state.lyricData.playName).toBe("Song B");
    expect(view.state.playSeekMs.value).toBe(2300);
  });

  it("生产resize接受实际bounds回执且卸载后晚回不写状态", async () => {
    const view = mountView("mygo");
    view.fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await flush();
    const response = deferred<LyricsWindowState>();
    view.fixture.provider.setBounds.mockImplementation(() => response.promise);
    view.state.sendToMain("update-lyric-size", 900, 240);
    expect(view.fixture.provider.setBounds).toHaveBeenCalledWith(7, {
      x: 100,
      y: 200,
      width: 900,
      height: 240,
    });
    view.state.sendToMain("move-window", NaN, 1, 2, 3);
    expect(view.fixture.provider.setBounds).toHaveBeenCalledTimes(1);
    response.resolve({
      ...windowState(5),
      bounds: { x: 101, y: 201, width: 880, height: 230 },
    });
    await flush();
    expect(view.state.cachedBounds.width).toBe(880);
    const late = deferred<LyricsWindowState>();
    view.fixture.provider.setBounds.mockImplementation(() => late.promise);
    view.state.sendToMain("update-window-height", 260);
    expect(view.fixture.provider.setBounds).toHaveBeenLastCalledWith(7, {
      x: 101,
      y: 201,
      width: 880,
      height: 260,
    });
    view.unmount();
    late.resolve({
      ...windowState(6),
      bounds: { x: 0, y: 0, width: 999, height: 999 },
    });
    await flush();
    expect(view.state.cachedBounds.width).toBe(880);
  });

  it("生产Attach拒绝后错误可见且精确退订", async () => {
    const view = mountView("mygo");
    view.fixture.attachment.reject(new Error("attach failed"));
    await flush();
    expect(text(view.root)).toContain("message.desktop_lyrics_connection_failed");
    expect(view.fixture.off.every((off) => off.mock.calls.length === 1)).toBe(true);
  });
});

describe("desktopLyricsConsumer ordering and disposal", () => {
  it("跨track clock B10先到，晚Attach A5后B8歌词与B10时钟合并", async () => {
    const fixture = providerFixture();
    const consumer = createDesktopLyricsConsumer(fixture.provider);
    cleanups.push(consumer.dispose);
    const started = consumer.start();
    fixture.emitClock(clock(10, "B"));
    fixture.attachment.resolve({ window: windowState(), snapshot: snapshot(5, "A") });
    await started;
    fixture.emitSnapshot(snapshot(8, "B"));
    expect(consumer.snapshot.value?.playName).toBe("Song B");
    expect(consumer.clock.value).toEqual(clock(10, "B"));
    fixture.emitSnapshot(snapshot(7, "B"));
    fixture.emitClock(clock(9, "B"));
    expect(consumer.clock.value?.seq).toBe(10);
  });

  it("拒旧bounds/getState回执与卸载后晚回，off抛错仍全部精确退订", async () => {
    const fixture = providerFixture();
    const consumer = createDesktopLyricsConsumer(fixture.provider);
    const started = consumer.start();
    fixture.attachment.resolve({ window: windowState(), snapshot: snapshot() });
    await started;
    const response = deferred<LyricsWindowState>();
    fixture.provider.getState.mockImplementation(() => response.promise);
    const refreshing = consumer.refreshBounds();
    fixture.emitWindow(windowState(8));
    response.resolve(windowState(2));
    await refreshing;
    expect(consumer.windowState.value?.revision).toBe(8);
    const boundsResponse = deferred<LyricsWindowState>();
    fixture.provider.setBounds.mockImplementation(() => boundsResponse.promise);
    const resizing = consumer.setBounds({ x: 1, y: 2, width: 3, height: 4 });
    fixture.off[0].mockImplementation(() => {
      throw new Error("off failed");
    });
    expect(() => consumer.dispose()).not.toThrow();
    boundsResponse.resolve(windowState(9));
    await resizing;
    expect(consumer.windowState.value?.revision).toBe(8);
    expect(fixture.off.every((off) => off.mock.calls.length === 1)).toBe(true);
  });

  it("Attach reject释放订阅且不泄露reject，缺provider安全失败", async () => {
    const fixture = providerFixture();
    const consumer = createDesktopLyricsConsumer(fixture.provider);
    fixture.off[0].mockImplementation(() => {
      throw new Error("off failed");
    });
    const started = consumer.start();
    fixture.attachment.reject(new Error("attach failed"));
    await expect(started).resolves.toBeUndefined();
    expect(consumer.status.value).toBe("failed");
    expect(fixture.off.every((off) => off.mock.calls.length === 1)).toBe(true);
    const web = createDesktopLyricsConsumer(undefined);
    await web.start();
    expect(web.status.value).toBe("failed");
  });
});
