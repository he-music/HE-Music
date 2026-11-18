import { afterEach, expect, it, vi } from "vitest";
import { KineticScene } from "./KineticScene";

// Pixi 8 异步初始化完成前离开效果时，必须销毁实例而不创建场景资源。
const mocks = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  destroy: vi.fn(),
  container: vi.fn(),
}));
vi.mock("pixi.js", () => ({
  Application: class {
    init = mocks.initialize;
    destroy = mocks.destroy;
  },
  Container: mocks.container,
  CanvasSource: vi.fn(),
  Sprite: vi.fn(),
  Texture: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("releases a renderer that finishes initializing after cancellation", async () => {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  let finish: () => void = () => {};
  mocks.initialize.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = KineticScene.create(
    {} as HTMLCanvasElement,
    {
      family: "sans-serif",
      weight: "700",
      style: "normal",
      size: 36,
      translationSize: 18,
      romanizationSize: 16,
    },
    controller.signal,
  );
  controller.abort();
  finish();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.container).not.toHaveBeenCalled();
});
