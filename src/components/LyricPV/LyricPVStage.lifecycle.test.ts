import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mountProductionSfc, flushSfcHost } from "@/test/productionSfc";
import { adaptPartitaLines, resolvePartitaFrame } from "@/components/Partita/model";
import { useStageClock } from "@/components/LyricStage/useStageClock";
import type { PVRuntime, PVRuntimeOptions } from "./runtime";

// 用生产 Vue 组件验证异步初始化清理与高频时钟隔离；真正的 WebGL 另在浏览器验证。
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", (element: object) => {
    Object.assign(element, { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    return { fontFamily: "sans-serif", fontWeight: "700" };
  });
  vi.stubGlobal("document", { fonts: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
function runtime(): PVRuntime {
  return {
    swapSong: vi.fn(async () => {}),
    setPaused: vi.fn(),
    setStaticMode: vi.fn(),
    renderOnce: vi.fn(),
    destroy: vi.fn(),
  };
}
function mount(
  create: (mode: string, options: PVRuntimeOptions) => Promise<PVRuntime>,
  time = ref(1000),
  fullBleed = false,
) {
  const updates = vi.fn();
  const onScreen = ref(true);
  const safeArea = ref<{ top: number; bottom: number }>();
  const lines = adaptPartitaLines(
    [
      {
        startTime: 0,
        endTime: 4000,
        words: [{ word: "第一句", startTime: 0, endTime: 4000 }],
        translatedLyric: "First line",
      },
      {
        startTime: 5000,
        endTime: 9000,
        words: [{ word: "第二句", startTime: 5000, endTime: 9000 }],
        translatedLyric: "Second line",
      },
    ],
    true,
  );
  const host = mountProductionSfc(
    new URL("./LyricPVStage.vue", import.meta.url),
    {
      "@vueuse/core": {
        useDocumentVisibility: () => ref("visible"),
        useElementVisibility: () => onScreen,
        usePreferredReducedMotion: () => ref("no-preference"),
      },
      "@/components/Partita/model": { resolvePartitaFrame },
      "@/components/LyricStage/useStageClock": { useStageClock },
      "@/components/LyricStage/retireCanvasScene": {
        retireCanvasScene: (scene: PVRuntime) => scene.destroy(),
      },
      "./model": { adaptPVLines: () => [], createPVTheme: () => ({}) },
      "./usePVSafeArea": { usePVSafeArea: () => safeArea },
      "./audio": { createPVAudioSignals: () => ({}) },
      "./runtime": {
        createPVRuntime: (mode: string, options: PVRuntimeOptions) => {
          Object.assign(options.host, { querySelector: () => undefined });
          return create(mode, options);
        },
      },
      probe: { updates },
    },
    [],
    'import { onUpdated } from "vue"; import { updates } from "probe"; onUpdated(updates);',
    {
      mode: "hanabi",
      fullBleed,
      lines,
      clock: { time },
      seed: "test",
      duration: 4000,
      playing: true,
    },
  );
  cleanups.push(host.close);
  return { host, updates, time, onScreen, safeArea };
}

it("updates the scene after the new safe-area DOM styles are applied", async () => {
  const next = runtime();
  const { host, safeArea } = mount(async () => next, ref(1000), true);
  await flushSfcHost();
  let appliedStyle: unknown;
  vi.mocked(next.swapSong).mockImplementation(async () => {
    const stage = host.all().find((node) => node.props.class === "lyric-pv hanabi full-bleed");
    appliedStyle = stage?.props.style;
  });
  safeArea.value = { top: 0.25, bottom: 0.13 };
  await flushSfcHost();
  expect(next.swapSong).toHaveBeenCalledOnce();
  expect(appliedStyle).toEqual({ "--pv-safe-bottom": "13%" });
});

it("aborts an unfinished initialization and destroys a late runtime after unmount", async () => {
  let finish: (value: PVRuntime) => void = () => {};
  let signal: AbortSignal | undefined;
  const next = runtime();
  const { host } = mount((_mode, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  host.close();
  expect(signal?.aborted).toBe(true);
  finish(next);
  await flushSfcHost();
  expect(next.destroy).toHaveBeenCalledOnce();
});

it("does not re-render the Vue tree or recreate the engine on playback ticks", async () => {
  const next = runtime();
  const create = vi.fn(async () => next);
  const { host, updates, time } = mount(create);
  await flushSfcHost();
  updates.mockClear();
  for (let index = 0; index < 30; index++) {
    time.value += 16;
    await flushSfcHost();
  }
  expect(updates).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledOnce();
  expect(next.swapSong).not.toHaveBeenCalled();
  time.value = 5100;
  await flushSfcHost();
  expect(updates).toHaveBeenCalledOnce();
  expect(host.all().some((node) => node.text === "Second line")).toBe(true);
  expect(create).toHaveBeenCalledOnce();
  host.close();
  expect(next.setPaused).toHaveBeenLastCalledWith(true);
  expect(next.destroy).toHaveBeenCalledOnce();
});

it("pauses an off-screen mobile lyric page and resumes without recreating its engine", async () => {
  const next = runtime();
  const create = vi.fn(async () => next);
  const { onScreen } = mount(create);
  await flushSfcHost();
  onScreen.value = false;
  await flushSfcHost();
  expect(next.setPaused).toHaveBeenLastCalledWith(true);
  onScreen.value = true;
  await flushSfcHost();
  expect(next.setPaused).toHaveBeenLastCalledWith(false);
  expect(create).toHaveBeenCalledOnce();
});
