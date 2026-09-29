import { onScopeDispose, watch, type Ref } from "vue";

/** 手势只作用于视频画面，控件、全屏和评论抽屉不参与切换。 */
export function useVideoGestures(
  surface: Ref<HTMLElement | null>,
  enabled: Ref<boolean>,
  change: (direction: -1 | 1) => void,
) {
  let cleanup = () => {};
  watch(
    [surface, enabled],
    ([element, active]) => {
      cleanup();
      if (!element || !active) return;
      let start: { id: number; x: number; y: number } | null = null;
      let distance = 0;
      let wheel = 0;
      let lastWheel = 0;
      let switched = false;
      let dragged = false;
      const blocked = (target: EventTarget | null) =>
        !!document.fullscreenElement ||
        (target instanceof Element &&
          !!target.closest(
            "button:not(.plyr__control--overlaid),input,select,[role=slider],.plyr__controls,.plyr__menu,.hls-quality,.player-state",
          ));
      const reset = () => {
        start = null;
        distance = 0;
        element.style.removeProperty("--swipe-y");
      };
      const down = (e: PointerEvent) => {
        if (e.pointerType === "mouse" || !e.isPrimary || blocked(e.target)) return;
        dragged = false;
        start = { id: e.pointerId, x: e.clientX, y: e.clientY };
      };
      const move = (e: PointerEvent) => {
        if (!start || start.id !== e.pointerId) return;
        const y = e.clientY - start.y;
        if (Math.abs(e.clientX - start.x) > Math.abs(y) && !dragged) {
          reset();
          return;
        }
        if (Math.abs(y) < 10 && !dragged) return;
        dragged = true;
        element.setPointerCapture(e.pointerId);
        distance = y;
        element.style.setProperty("--swipe-y", `${Math.max(-80, Math.min(80, y * 0.4))}px`);
        e.preventDefault();
      };
      const up = (e: PointerEvent) => {
        if (!start || start.id !== e.pointerId) return;
        const delta = distance;
        reset();
        if (Math.abs(delta) >= 60) change(delta < 0 ? 1 : -1);
      };
      const click = (e: MouseEvent) => {
        if (dragged) {
          e.preventDefault();
          e.stopPropagation();
          dragged = false;
        }
      };
      const scroll = (e: WheelEvent) => {
        if (blocked(e.target) || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheel > 180) {
          wheel = 0;
          switched = false;
        }
        lastWheel = now;
        if (switched) return;
        wheel += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1);
        if (Math.abs(wheel) >= 100) {
          switched = true;
          change(wheel > 0 ? 1 : -1);
        }
      };
      element.addEventListener("pointerdown", down);
      element.addEventListener("pointermove", move, { passive: false });
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", reset);
      element.addEventListener("click", click, true);
      element.addEventListener("wheel", scroll, { passive: false });
      cleanup = () => {
        reset();
        element.removeEventListener("pointerdown", down);
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", reset);
        element.removeEventListener("click", click, true);
        element.removeEventListener("wheel", scroll);
      };
    },
    { flush: "post" },
  );
  onScopeDispose(() => cleanup());
}
