import { onBeforeUnmount, ref, type Ref } from "vue";
import { clamp } from "./motion";

// src/components/Monet/useMonetBrowse.ts — 手动浏览暂时脱离跟随，空闲后回到演唱位置。
export function useMonetBrowse(count: () => number, anchor: Readonly<Ref<number>>) {
  const manualAnchor = ref<number | null>(null);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let accumulated = 0;
  let touch: { x: number; y: number; lastY: number } | undefined;
  let axis: "horizontal" | "vertical" | undefined;
  let moved = false;
  let hoverPaused = false;
  function reset() {
    clearTimeout(resetTimer);
    manualAnchor.value = null;
    accumulated = 0;
  }
  function scheduleReset() {
    clearTimeout(resetTimer);
    if (!hoverPaused && !touch) resetTimer = setTimeout(reset, 1800);
  }
  function move(delta: number) {
    if (!count()) return;
    if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    accumulated += delta;
    if (Math.abs(accumulated) >= 52) {
      manualAnchor.value = clamp(
        (manualAnchor.value ?? anchor.value) + Math.sign(accumulated),
        0,
        count() - 1,
      );
      accumulated = 0;
    }
    scheduleReset();
  }
  function isOverflowingLine(target: EventTarget | null) {
    const line =
      target instanceof Element ? target.closest<HTMLElement>(".monet-line.active") : null;
    return Boolean(line?.classList.contains("monet-overflow"));
  }
  function wheel(event: WheelEvent) {
    event.stopPropagation();
    // 超长的当前歌词保留原生内部滚动，确保每一行文字都能读到。
    if (isOverflowingLine(event.target)) return;
    event.preventDefault();
    move(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1));
  }
  function touchStart(event: TouchEvent) {
    if (event.touches.length !== 1) {
      touchEnd();
      return;
    }
    const point = event.touches[0];
    touch = { x: point.clientX, y: point.clientY, lastY: point.clientY };
    axis = undefined;
    moved = false;
    clearTimeout(resetTimer);
  }
  function touchMove(event: TouchEvent) {
    if (!touch || event.touches.length !== 1) return;
    const point = event.touches[0];
    if (!axis) {
      const dx = Math.abs(point.clientX - touch.x);
      const dy = Math.abs(point.clientY - touch.y);
      if (Math.max(dx, dy) < 10) return;
      axis = dx > dy ? "horizontal" : "vertical";
      moved = true;
    }
    // 横向事件交给移动播放器分页，纵向事件只用于浏览歌词。
    if (axis === "horizontal") return;
    event.stopPropagation();
    if (!isOverflowingLine(event.target)) {
      if (event.cancelable) event.preventDefault();
      move(touch.lastY - point.clientY);
    }
    touch.lastY = point.clientY;
  }
  function touchEnd() {
    touch = undefined;
    axis = undefined;
    scheduleReset();
  }
  function enter(pause: boolean) {
    hoverPaused = pause;
    if (pause) {
      clearTimeout(resetTimer);
      manualAnchor.value ??= anchor.value;
    }
  }
  function leave() {
    hoverPaused = false;
    scheduleReset();
  }
  function allowClick() {
    if (moved) {
      moved = false;
      return false;
    }
    reset();
    return true;
  }
  onBeforeUnmount(() => clearTimeout(resetTimer));
  return {
    manualAnchor,
    reset,
    wheel,
    touchStart,
    touchMove,
    touchEnd,
    enter,
    leave,
    allowClick,
  };
}
