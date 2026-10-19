import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTouchContextMenu } from "./touchContextMenu";

class TestMouseEvent extends Event {
  readonly clientX: number;
  readonly clientY: number;

  constructor(type: string, options: MouseEventInit = {}) {
    super(type, options);
    this.clientX = options.clientX ?? 0;
    this.clientY = options.clientY ?? 0;
  }
}

const point = (clientX = 40, clientY = 80, identifier = 1) => ({
  clientX,
  clientY,
  identifier,
});

const touchEvent = (type: string, touches = [point()]) => {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  return event;
};

const setup = () => {
  const doc = new EventTarget();
  // Node 环境只模拟此事件适配器使用的 DOM 接口，真实冒泡另在浏览器验证。
  const el = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    classList: { add: vi.fn(), remove: vi.fn() },
  }) as unknown as HTMLElement;
  const binding = bindTouchContextMenu(el);
  const open = vi.fn();
  const click = vi.fn();
  el.addEventListener("contextmenu", open);
  el.addEventListener("click", click);
  return { el, doc, binding, open, click };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MouseEvent", TestMouseEvent);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("触屏长按菜单", () => {
  it("长按 450ms 在触点打开菜单，并拦截系统菜单和重复事件", () => {
    const { el, doc, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    const nativeBefore = new MouseEvent("contextmenu", { cancelable: true });
    el.dispatchEvent(nativeBefore);
    expect(nativeBefore.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(449);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toMatchObject({ clientX: 40, clientY: 80 });
    doc.dispatchEvent(touchEvent("touchend", []));
    el.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("短按保留正常点击", () => {
    const { el, doc, open, click } = setup();
    const start = touchEvent("touchstart");
    el.dispatchEvent(start);
    vi.advanceTimersByTime(100);
    const end = touchEvent("touchend", []);
    doc.dispatchEvent(end);
    el.dispatchEvent(new MouseEvent("click"));
    vi.advanceTimersByTime(500);
    expect(start.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it("长按后松手不触发点击，下一次主动点击仍正常", () => {
    const { el, doc, click } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    vi.advanceTimersByTime(1500);
    const end = touchEvent("touchend", []);
    doc.dispatchEvent(end);
    const ghostClick = new MouseEvent("click", { cancelable: true });
    el.dispatchEvent(ghostClick);
    expect(end.defaultPrevented).toBe(true);
    expect(ghostClick.defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();
    el.dispatchEvent(touchEvent("touchstart"));
    doc.dispatchEvent(touchEvent("touchend", []));
    el.dispatchEvent(new MouseEvent("click"));
    expect(click).toHaveBeenCalledOnce();
  });

  it("长按打开菜单后发生滚动，延迟松手仍不会误点击", () => {
    const { el, doc, open, click } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    vi.advanceTimersByTime(450);
    doc.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(1500);
    doc.dispatchEvent(touchEvent("touchend", []));
    el.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    expect(open).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it("滑动超过容差取消长按，保留浏览器滚动", () => {
    const { el, doc, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    vi.advanceTimersByTime(200);
    const move = touchEvent("touchmove", [point(40, 100)]);
    doc.dispatchEvent(move);
    vi.advanceTimersByTime(500);
    expect(move.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("容差内的手指抖动不会取消长按", () => {
    const { el, doc, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    doc.dispatchEvent(touchEvent("touchmove", [point(43, 84)]));
    vi.advanceTimersByTime(450);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["touchcancel", "scroll"])("%s 时取消待触发菜单", (type) => {
    const { el, doc, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    doc.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
  });

  it("在卡片外加入第二根手指也会取消长按", () => {
    const { el, doc, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    doc.dispatchEvent(touchEvent("touchstart", [point(), point(100, 100, 2)]));
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
  });

  it("初始多指触摸不会打开菜单", () => {
    const { el, open } = setup();
    el.dispatchEvent(touchEvent("touchstart", [point(), point(100, 100, 2)]));
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
  });

  it("取消旧资源的待触发长按后，新资源仍可长按", () => {
    const { el, binding, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    binding.cancel();
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
    el.dispatchEvent(touchEvent("touchstart"));
    vi.advanceTimersByTime(450);
    expect(open).toHaveBeenCalledOnce();
  });

  it("卸载时清理定时器与事件监听", () => {
    const { el, doc, binding, open } = setup();
    el.dispatchEvent(touchEvent("touchstart"));
    binding.dispose();
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    el.dispatchEvent(touchEvent("touchstart"));
    doc.dispatchEvent(touchEvent("touchend", []));
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
    expect(el.classList.remove).toHaveBeenCalledWith("touch-context-menu");
  });

  it("桌面右键保留应用菜单并阻止系统菜单", () => {
    const { el, open } = setup();
    const event = new MouseEvent("contextmenu", { cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});
