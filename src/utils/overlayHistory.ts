type Overlay = { close: () => void };
type HistoryHost = {
  history: Pick<History, "state" | "pushState" | "back">;
  location: Pick<Location, "href">;
  addEventListener: (type: string, listener: EventListener, capture: boolean) => void;
  removeEventListener: (type: string, listener: EventListener, capture: boolean) => void;
};

/** 所有临时界面共用一个历史占位，返回时逐层关闭，避免污染页面路由。 */
export function createOverlayHistory(host: HistoryHost) {
  const overlays: Overlay[] = [];
  let hasEntry = false;
  let navigating = false;
  let cleanup: Promise<void> | undefined;
  let finishCleanup: (() => void) | undefined;

  function sync() {
    if (overlays.length && !hasEntry && !cleanup && !navigating) {
      const state: unknown = host.history.state;
      host.history.pushState(
        { ...(typeof state === "object" && state !== null ? state : {}) },
        "",
        host.location.href,
      );
      hasEntry = true;
    }
  }

  function removeEntry() {
    if (!hasEntry || cleanup) return;
    hasEntry = false;
    cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    host.history.back();
  }

  function onPopState(event: Event) {
    if (!hasEntry && !cleanup) return;
    event.stopImmediatePropagation();
    if (cleanup) {
      const finish = finishCleanup;
      cleanup = undefined;
      finishCleanup = undefined;
      sync();
      finish?.();
      return;
    }
    hasEntry = false;
    overlays.pop()?.close();
    sync();
  }

  function add(close: () => void) {
    const overlay = { close };
    overlays.push(overlay);
    sync();
    return () => {
      const index = overlays.indexOf(overlay);
      if (index < 0) return;
      overlays.splice(index, 1);
      if (!overlays.length) removeEntry();
      sync();
    };
  }

  /** 页面主动跳转前清理占位，避免路由把临时记录当成上一页。 */
  async function beforeNavigation() {
    navigating = true;
    const closing = overlays.splice(0);
    for (const overlay of closing.reverse()) overlay.close();
    removeEntry();
    await cleanup;
    navigating = false;
    sync();
  }

  function dispose() {
    void beforeNavigation().finally(() => {
      host.removeEventListener("popstate", onPopState, true);
    });
  }

  // 必须在创建路由历史前注册，并保持注册顺序直到主应用卸载。
  host.addEventListener("popstate", onPopState, true);
  return { add, beforeNavigation, dispose };
}

let overlayHistory: ReturnType<typeof createOverlayHistory> | undefined;

export function getOverlayHistory() {
  return (overlayHistory ??= createOverlayHistory(window));
}

export function closeOverlaysBeforeNavigation() {
  return overlayHistory?.beforeNavigation();
}

export function disposeOverlayHistory() {
  overlayHistory?.dispose();
  overlayHistory = undefined;
}
