import { describe, expect, it, vi } from "vitest";
import { createOverlayHistory } from "./overlayHistory";

function fixture() {
  const host = new EventTarget();
  const entries = [{ route: "/home", position: 0 }];
  let index = 0;
  let pendingBack = false;
  const history = {
    get state() {
      return entries[index];
    },
    pushState: vi.fn((state: (typeof entries)[number]) => {
      entries.splice(++index, entries.length, state);
    }),
    back: vi.fn(() => {
      pendingBack = true;
    }),
  };
  const controller = createOverlayHistory({
    history,
    location: { href: "http://localhost/#/home" },
    addEventListener: host.addEventListener.bind(host),
    removeEventListener: host.removeEventListener.bind(host),
  });
  const routeListener = vi.fn();
  host.addEventListener("popstate", routeListener);
  const pop = () => {
    const event = new Event("popstate");
    host.dispatchEvent(event);
    return event;
  };
  const finishBack = () => {
    expect(pendingBack).toBe(true);
    pendingBack = false;
    index--;
    return pop();
  };
  const back = () => {
    history.back();
    return finishBack();
  };
  return { controller, history, routeListener, back, finishBack, pop, entries };
}

describe("移动端界面返回栈", () => {
  it("依次关闭最上层抽屉和播放器，页面路由不响应这些返回", () => {
    const view = fixture();
    const player = vi.fn();
    const drawer = vi.fn();
    view.controller.add(player);
    view.controller.add(drawer);
    expect(view.history.pushState).toHaveBeenCalledTimes(1);
    expect(view.history.state).toEqual({ route: "/home", position: 0 });
    view.back();
    expect(drawer).toHaveBeenCalledOnce();
    expect(player).not.toHaveBeenCalled();
    expect(view.routeListener).not.toHaveBeenCalled();
    view.back();
    expect(player).toHaveBeenCalledOnce();
    expect(view.routeListener).not.toHaveBeenCalled();
    view.pop();
    expect(view.routeListener).toHaveBeenCalledOnce();
  });

  it("手动关闭最后一层会回收占位，不会额外关闭其他界面", () => {
    const view = fixture();
    const close = vi.fn();
    const release = view.controller.add(close);
    release();
    expect(view.history.back).toHaveBeenCalledOnce();
    view.finishBack();
    expect(close).not.toHaveBeenCalled();
    expect(view.routeListener).not.toHaveBeenCalled();
    expect(view.history.state).toEqual({ route: "/home", position: 0 });
    view.pop();
    expect(view.routeListener).toHaveBeenCalledOnce();
  });

  it("菜单切换期间不丢失新打开的抽屉", () => {
    const view = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const release = view.controller.add(first);
    release();
    view.controller.add(second);
    view.finishBack();
    expect(second).not.toHaveBeenCalled();
    view.back();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("移除下层界面不影响仍打开的上层界面", () => {
    const view = fixture();
    const player = vi.fn();
    const drawer = vi.fn();
    const release = view.controller.add(player);
    view.controller.add(drawer);
    release();
    expect(view.history.back).not.toHaveBeenCalled();
    view.back();
    expect(drawer).toHaveBeenCalledOnce();
    expect(player).not.toHaveBeenCalled();
  });

  it("主动路由跳转先回收占位并关闭临时界面，再放行导航", async () => {
    const view = fixture();
    const player = vi.fn();
    const drawer = vi.fn();
    view.controller.add(player);
    view.controller.add(drawer);
    let finished = false;
    const navigation = view.controller.beforeNavigation().then(() => {
      finished = true;
    });
    expect(drawer).toHaveBeenCalledOnce();
    expect(player).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    view.finishBack();
    await navigation;
    expect(finished).toBe(true);
    expect(view.history.state).toEqual({ route: "/home", position: 0 });
    expect(view.routeListener).not.toHaveBeenCalled();
  });
});
