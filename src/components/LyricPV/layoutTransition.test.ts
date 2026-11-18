import { afterEach, expect, it, vi } from "vitest";
import { HanabiPixiRuntime } from "./vendor/components/visualizer/hanabi/createHanabiPixiRuntime";
import { LumierePixiRuntime } from "./vendor/components/visualizer/lumiere/createLumierePixiRuntime";

// 直接执行生产引擎的布局更新分支，保护“新画布尺寸 + 旧歌词构图”的短暂错帧。
afterEach(() => {
  vi.useRealTimers();
});
for (const Engine of [HanabiPixiRuntime, LumierePixiRuntime]) {
  it.each([false, true])(
    `${Engine.name} commits new dimensions and paints synchronously (paused: %s)`,
    async (paused) => {
      vi.useFakeTimers();
      const order: string[] = [];
      const delayedRebuild = vi.fn();
      const runtime = {
        destroyed: false,
        options: { song: { seed: "same-song" }, paused },
        width: 1200,
        sceneCache: { size: 1 },
        songSwap: { active: false },
        rebuildDue: true,
        rebuildTimer: setTimeout(delayedRebuild, 220),
        resizeToHost: vi.fn(() => {
          runtime.width = 600;
          order.push("resize");
          return true;
        }),
        commitSong: vi.fn(() => {
          expect(runtime.width).toBe(600);
          order.push("layout");
        }),
        renderOnce: vi.fn(() => {
          order.push("paint");
        }),
      };
      await Reflect.apply(Engine.prototype.swapSong, runtime, [{ seed: "same-song" }]);
      expect(order).toEqual(["resize", "layout", "paint"]);
      expect(runtime.rebuildDue).toBe(false);
      vi.runAllTimers();
      expect(delayedRebuild).not.toHaveBeenCalled();
    },
  );
}
