import { afterEach, expect, it, vi } from "vitest";
import { createRenderer, defineComponent, nextTick, ref } from "vue";
import { usePVSafeArea } from "./usePVSafeArea";

// 测试真实 composable 的测量时机、相等保护及离开布局后的资源清理。
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("measures floating controls only on layout changes and clears observers and scheduled work", async () => {
  vi.useFakeTimers();
  let resize: () => void = () => {};
  const disconnect = vi.fn(),
    observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  let infoBottom = 180;
  const info = { getBoundingClientRect: () => ({ bottom: infoBottom }) };
  const control = { getBoundingClientRect: () => ({ top: 720 }) };
  const player = {
    querySelector: (selector: string) => (selector.includes("player-data") ? info : control),
    querySelectorAll: () => [info, control],
  };
  const element = {
    closest: () => player,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }),
  };
  const enabled = ref(true);
  let area: ReturnType<typeof usePVSafeArea> | undefined;
  const renderer = createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    patchProp: () => {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp(
    defineComponent({
      setup() {
        area = usePVSafeArea(ref(element as unknown as HTMLElement), () => enabled.value);
        return () => null;
      },
    }),
  );
  app.mount({});
  try {
    expect(area?.value).toEqual({ top: 0.25, bottom: 0.13 });
    expect(observe).toHaveBeenCalledTimes(3);
    const previous = area?.value;
    resize();
    vi.runAllTimers();
    expect(area?.value).toBe(previous);
    infoBottom = 260;
    resize();
    resize();
    resize();
    expect(area?.value).toBe(previous);
    vi.runAllTimers();
    expect(area?.value?.top).toBe(0.35);
    enabled.value = false;
    await nextTick();
    expect(area?.value).toBeUndefined();
    expect(disconnect).toHaveBeenCalled();
    enabled.value = true;
    await nextTick();
    resize();
  } finally {
    app.unmount();
  }
  expect(vi.getTimerCount()).toBe(0);
});
