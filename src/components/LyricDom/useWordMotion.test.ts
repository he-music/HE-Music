import { afterEach, expect, it, vi } from "vitest";
import { createRenderer, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import { useWordMotion, type MotionOptions } from "./useWordMotion";
import { toStageLine } from "./model";
import { adaptPartitaLines } from "@/components/Partita/model";

// 在真实 Vue 生命周期里验证暂停、回拖、隐藏、卸载，DOM 只保留动画宿主实际读取的接口。
afterEach(() => vi.unstubAllGlobals());
async function mountMotion() {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const glyph = { style: { textShadow: "", color: "", opacity: "" } };
  const node = {
    dataset: { motionIndex: "0", status: "" },
    style: { transform: "", opacity: "" },
    querySelectorAll: () => [glyph],
  };
  const element = { querySelectorAll: () => [node] } as unknown as HTMLElement;
  const root = shallowRef<HTMLElement | null>(null);
  const clock = ref(500);
  const running = ref(true);
  const reduced = ref(false);
  const line = toStageLine(
    adaptPartitaLines(
      [{ startTime: 1000, endTime: 2000, words: [{ word: "歌", startTime: 1000, endTime: 2000 }] }],
      true,
    )[0],
  );
  const options = shallowRef<MotionOptions>({
    line,
    items: [
      { word: line.words[0], config: { x: 6, y: 2, scale: 1.2, rotate: 3, passedRotate: -5 } },
    ],
    color: "#ffffff",
    wordAnimation: true,
    visible: true,
    rotation: true,
  });
  const renderer = createRenderer<object, object>({
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
  const app = renderer.createApp(
    defineComponent({
      setup() {
        useWordMotion(root, clock, running, reduced, () => options.value);
        return () => h("div");
      },
    }),
  );
  app.mount({});
  root.value = element;
  await nextTick();
  return { app, clock, running, reduced, options, frames, node, glyph };
}
it("只在三态变化时启用运动帧，暂停取消帧，跳转立即恢复对应姿态", async () => {
  const p = await mountMotion();
  expect(p.node.dataset.status).toBe("waiting");
  const pending = p.frames.size;
  p.clock.value = 516;
  expect(p.frames.size).toBe(pending);
  p.clock.value = 900;
  expect(p.node.dataset.status).toBe("active");
  p.running.value = false;
  await nextTick();
  expect(p.frames.size).toBe(0);
  p.clock.value = 2500;
  expect(p.node.dataset.status).toBe("passed");
  expect(p.node.style.transform).toContain("rotate(-2deg)");
  p.clock.value = 500;
  expect(p.node.dataset.status).toBe("waiting");
  expect(p.node.style.opacity).toBe("0");
  p.app.unmount();
  expect(p.frames.size).toBe(0);
});
it("跳转到唱完状态后的首个运动帧不回弹到跳转前的位置", async () => {
  const p = await mountMotion();
  p.clock.value = 2500;
  const pose = { ...p.node.style };
  for (const [id, callback] of [...p.frames]) {
    p.frames.delete(id);
    callback(performance.now() + 16);
  }
  expect(p.node.style).toEqual(pose);
  p.app.unmount();
});
it("隐藏时不写入高频样式，恢复和减少动态效果后重新同步", async () => {
  const p = await mountMotion();
  p.options.value = { ...p.options.value, visible: false };
  p.running.value = false;
  await nextTick();
  const before = { ...p.node.style };
  p.clock.value = 1500;
  expect(p.node.style).toEqual(before);
  p.options.value = { ...p.options.value, visible: true };
  p.reduced.value = true;
  await nextTick();
  expect(p.node.dataset.status).toBe("active");
  expect(p.node.style.transform).toContain("scale(1)");
  expect(p.glyph.style.opacity).toBe("0");
  expect(p.frames.size).toBe(0);
  p.app.unmount();
});
