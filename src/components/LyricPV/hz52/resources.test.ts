import { afterEach, expect, it, vi } from "vitest";
import { BindGroup, BufferImageSource } from "pixi.js";
import { release52HzFields } from "./resources";

// 使用 Pixi 的真实绑定组，确保距离场释放时已经解除监听，避免只验证 mock 调用顺序。
afterEach(() => vi.restoreAllMocks());
it("unbinds the field shader before destroying bound textures", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sources = Array.from(
    { length: 4 },
    () =>
      new BufferImageSource({
        resource: new Float32Array(16),
        width: 4,
        height: 4,
        format: "r32float",
      }),
  );
  const group = new BindGroup(Object.fromEntries(sources.map((source, index) => [index, source])));
  const sprite = { filters: [] };
  release52HzFields(sprite, { destroy: () => group.destroy() }, sources);
  expect(sources.every((source) => source.destroyed)).toBe(true);
  expect(group.resources).toBeNull();
  expect(sprite.filters).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
});
