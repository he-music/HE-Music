import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AbstractRenderer, GlobalResourceRegistry, type RendererDestroyOptions } from "pixi.js";
import { createPVTheme } from "../model";
import { create52HzRuntime } from "./runtime";

// Pixi 初始化完成前取消选择时释放应用，初始化失败时不遗留 GPU 资源。
const mocks = vi.hoisted(() => ({ init: vi.fn<() => Promise<void>>(), destroy: vi.fn() }));
vi.mock("../vendor/components/visualizer/pixi/loadPixi", () => ({
  loadPixi: async () => ({
    Application: class {
      renderer = {};
      init = mocks.init;
      destroy = mocks.destroy;
    },
  }),
}));
const sharedPool = { clear: vi.fn() };
beforeEach(() => {
  GlobalResourceRegistry.register(sharedPool);
  mocks.destroy.mockImplementation((options: RendererDestroyOptions) => {
    // 使用真实的 Pixi 销毁策略验证全局池，省去此测试不需要的 WebGL 实例。
    Reflect.apply(
      AbstractRenderer.prototype.destroy,
      {
        runners: { destroy: { items: [], emit() {}, destroy() {} } },
        removeAllListeners() {},
      },
      [options],
    );
  });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("document", { createElement: () => ({ clientWidth: 640, clientHeight: 400 }) });
});
afterEach(() => {
  GlobalResourceRegistry.unregister(sharedPool);
  try {
    expect(sharedPool.clear).not.toHaveBeenCalled();
  } finally {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
const options = (signal: AbortSignal) => ({
  host: document.createElement("div"),
  song: {
    seed: "test",
    lines: [],
    duration: 100,
    title: "",
    artist: "",
    album: "",
    theme: createPVTheme("200, 160, 120", "sans-serif", 700, false),
  },
  currentTime: { get: () => 0 },
  audioPower: { get: () => 0 },
  audioBands: {
    bass: { get: () => 0 },
    mid: { get: () => 0 },
    treble: { get: () => 0 },
    vocal: { get: () => 0 },
  },
  paused: true,
  reduced: false,
  signal,
});
it("skips Pixi initialization when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(create52HzRuntime(options(controller.signal))).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(mocks.init).not.toHaveBeenCalled();
});
it("destroys a late initialized application after cancellation", async () => {
  let finish: (() => void) | undefined;
  mocks.init.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = create52HzRuntime(options(controller.signal));
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  controller.abort();
  finish?.();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.destroy).toHaveBeenCalledExactlyOnceWith(
    { removeView: true, releaseGlobalResources: false },
    { children: true },
  );
});
it("releases renderer resources after an initialization failure", async () => {
  const error = new Error("WebGL unavailable");
  mocks.init.mockRejectedValue(error);
  await expect(create52HzRuntime(options(new AbortController().signal))).rejects.toBe(error);
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
