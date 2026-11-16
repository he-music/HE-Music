import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useMonetBrowse } from "./useMonetBrowse";

const { cleanups } = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onBeforeUnmount: (cleanup: () => void) => cleanups.push(cleanup),
}));

class Line extends EventTarget {
  constructor(private overflow = false) {
    super();
  }
  closest() {
    return this;
  }
  classList = { contains: () => this.overflow };
}

function touch(x: number, y: number, target = new Line()) {
  return {
    touches: [{ clientX: x, clientY: y }],
    target,
    cancelable: true,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Element", Line);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Monet 触摸浏览", () => {
  it("横向滑动传递给分页，不浏览歌词，也不触发歌词跳转", () => {
    const browse = useMonetBrowse(() => 20, ref(5));
    browse.touchStart(touch(220, 200) as unknown as TouchEvent);
    const move = touch(60, 220);
    browse.touchMove(move as unknown as TouchEvent);
    browse.touchEnd();
    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(move.stopPropagation).not.toHaveBeenCalled();
    expect(browse.manualAnchor.value).toBeNull();
    expect(browse.allowClick()).toBe(false);
  });

  it("纵向滑动只浏览歌词，结束后恢复跟随", () => {
    const browse = useMonetBrowse(() => 20, ref(5));
    browse.touchStart(touch(100, 200) as unknown as TouchEvent);
    const move = touch(103, 130);
    browse.touchMove(move as unknown as TouchEvent);
    expect(move.preventDefault).toHaveBeenCalled();
    expect(move.stopPropagation).toHaveBeenCalled();
    expect(browse.manualAnchor.value).toBe(6);
    browse.touchEnd();
    vi.advanceTimersByTime(1800);
    expect(browse.manualAnchor.value).toBeNull();
  });

  it("超长歌词保留内部纵向滚动，横向仍可分页", () => {
    const browse = useMonetBrowse(() => 20, ref(5));
    const line = new Line(true);
    browse.touchStart(touch(100, 200, line) as unknown as TouchEvent);
    const vertical = touch(100, 100, line);
    browse.touchMove(vertical as unknown as TouchEvent);
    expect(vertical.preventDefault).not.toHaveBeenCalled();
    expect(vertical.stopPropagation).toHaveBeenCalled();
    expect(browse.manualAnchor.value).toBeNull();
    browse.touchEnd();
    browse.touchStart(touch(100, 200, line) as unknown as TouchEvent);
    const horizontal = touch(250, 210, line);
    browse.touchMove(horizontal as unknown as TouchEvent);
    expect(horizontal.stopPropagation).not.toHaveBeenCalled();
  });
});
