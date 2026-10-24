import type { ObjectDirective } from "vue";

const LONG_PRESS_DELAY = 450;
const MOVE_TOLERANCE = 10;
const GHOST_EVENT_DELAY = 800;

interface TouchContextMenuGesture {
  id: number;
  source: HTMLElement;
  ignoreUntil: number;
}

const menuGestures = new WeakMap<EventTarget, TouchContextMenuGesture>();

/** 菜单的外部关闭入口应忽略打开它的长按收尾，包含兼容鼠标松手。 */
export const shouldIgnoreTouchContextMenuOutside = (event: Event): boolean => {
  const target = event.target as Node | null;
  if (!target) return false;
  const gesture = menuGestures.get(target.ownerDocument ?? target);
  if (!gesture || Date.now() >= gesture.ignoreUntil) return false;
  if (event.type === "touchend") {
    return Array.from((event as TouchEvent).changedTouches).some(
      (touch) => touch.identifier === gesture.id,
    );
  }
  return event.type === "mouseup" && gesture.source.contains(target);
};

/** 为已有 contextmenu 入口补充触屏长按，不阻止正常点击和滚动。 */
export const bindTouchContextMenu = (el: HTMLElement) => {
  const doc = el.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touch: { id: number; x: number; y: number } | undefined;
  let longPressed = false;
  let dispatching = false;
  let ignoreNativeUntil = 0;
  let ignoreClickUntil = 0;

  let menuGesture: TouchContextMenuGesture | undefined;
  let menuGestureTimer: ReturnType<typeof setTimeout> | undefined;

  const clearMenuGesture = () => {
    if (menuGestureTimer !== undefined) clearTimeout(menuGestureTimer);
    menuGestureTimer = undefined;
    if (menuGestures.get(doc) === menuGesture) menuGestures.delete(doc);
    menuGesture = undefined;
    doc.removeEventListener("touchstart", clearMenuGesture, true);
  };

  const cancelPending = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const cancelTouch = () => {
    cancelPending();
    touch = undefined;
    doc.removeEventListener("touchstart", onAdditionalTouch, true);
    doc.removeEventListener("touchmove", onMove, true);
    doc.removeEventListener("touchend", onEnd, true);
    doc.removeEventListener("touchcancel", onCancel, true);
    doc.removeEventListener("scroll", onCancel, true);
  };

  const cancel = () => {
    cancelTouch();
    clearMenuGesture();
  };

  const onAdditionalTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) cancelPending();
  };

  const onMove = (event: TouchEvent) => {
    const current = Array.from(event.touches).find((item) => item.identifier === touch?.id);
    if (
      !touch ||
      event.touches.length !== 1 ||
      !current ||
      Math.hypot(current.clientX - touch.x, current.clientY - touch.y) > MOVE_TOLERANCE
    ) {
      cancelPending();
    }
  };

  const onEnd = (event: Event) => {
    const touchId = touch?.id;
    if (
      event.type === "touchend" &&
      touchId !== undefined &&
      !Array.from((event as TouchEvent).changedTouches).some((item) => item.identifier === touchId)
    ) {
      return;
    }
    ignoreNativeUntil = Date.now() + GHOST_EVENT_DELAY;
    if (longPressed) {
      // 阻止长按松手后合成的 click，避免播放、跳转或触发卡片内按钮。
      if (event.cancelable) event.preventDefault();
      ignoreClickUntil = Date.now() + GHOST_EVENT_DELAY;
      if (menuGesture) {
        menuGesture.ignoreUntil = ignoreClickUntil;
        menuGestureTimer = setTimeout(clearMenuGesture, GHOST_EVENT_DELAY);
      }
    }
    cancelTouch();
  };

  const onCancel = (event: Event) => {
    if (event.type === "scroll") {
      cancelPending();
    } else {
      onEnd(event);
    }
  };

  const onStart = (event: TouchEvent) => {
    cancel();
    longPressed = false;
    ignoreClickUntil = 0;
    if (event.touches.length !== 1) return;
    const first = event.touches[0];
    touch = { id: first.identifier, x: first.clientX, y: first.clientY };
    doc.addEventListener("touchstart", onAdditionalTouch, { passive: true, capture: true });
    doc.addEventListener("touchmove", onMove, { passive: true, capture: true });
    doc.addEventListener("touchend", onEnd, { passive: false, capture: true });
    doc.addEventListener("touchcancel", onCancel, { passive: true, capture: true });
    doc.addEventListener("scroll", onCancel, { passive: true, capture: true });
    timer = setTimeout(() => {
      timer = undefined;
      if (!touch) return;
      longPressed = true;
      // clickoutside 在 window 捕获阶段执行，必须在派发菜单前记录所属手势。
      menuGesture = { id: touch.id, source: el, ignoreUntil: Infinity };
      menuGestures.set(doc, menuGesture);
      doc.addEventListener("touchstart", clearMenuGesture, { passive: true, capture: true });
      ignoreClickUntil = Date.now() + GHOST_EVENT_DELAY;
      dispatching = true;
      try {
        el.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: touch.x,
            clientY: touch.y,
          }),
        );
      } finally {
        dispatching = false;
      }
    }, LONG_PRESS_DELAY);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    // 部分浏览器仍会产生原生 contextmenu，避免重复打开菜单。
    if (!dispatching && (touch || Date.now() < ignoreNativeUntil)) {
      event.stopImmediatePropagation();
    }
  };

  const onClick = (event: MouseEvent) => {
    if (Date.now() < ignoreClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  el.classList.add("touch-context-menu");
  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("contextmenu", onContextMenu, true);
  el.addEventListener("click", onClick, true);

  return {
    cancel,
    dispose: () => {
      cancel();
      el.classList.remove("touch-context-menu");
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("click", onClick, true);
    },
  };
};

const bindings = new WeakMap<HTMLElement, ReturnType<typeof bindTouchContextMenu>>();

export const touchContextMenuDirective: ObjectDirective<HTMLElement, unknown> = {
  mounted(el) {
    bindings.set(el, bindTouchContextMenu(el));
  },
  updated(el, binding) {
    // 虚拟列表复用节点时，取消旧资源尚未触发的长按。
    if (binding.value !== binding.oldValue) bindings.get(el)?.cancel();
  },
  beforeUnmount(el) {
    bindings.get(el)?.dispose();
    bindings.delete(el);
  },
};
