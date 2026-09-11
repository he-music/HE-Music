import { onBeforeUnmount, ref, type Ref } from "vue";
import { clamp } from "./motion";

// src/components/Monet/useMonetBrowse.ts — 手动浏览暂时脱离跟随，空闲后回到演唱位置。
export function useMonetBrowse(count: () => number, anchor: Readonly<Ref<number>>) {
  const manualAnchor = ref<number | null>(null);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let accumulated = 0;
  let pointerY: number | null = null;
  let moved = false;
  let hoverPaused = false;
  function reset() {
    clearTimeout(resetTimer);
    manualAnchor.value = null;
    accumulated = 0;
  }
  function scheduleReset() {
    clearTimeout(resetTimer);
    if (!hoverPaused && pointerY === null) resetTimer = setTimeout(reset, 1800);
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
  function touchMove(event: TouchEvent) {
    if (!isOverflowingLine(event.target)) event.preventDefault();
    event.stopPropagation();
  }
  function pointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse" || isOverflowingLine(event.target)) return;
    pointerY = event.clientY;
    moved = false;
    clearTimeout(resetTimer);
  }
  function pointerMove(event: PointerEvent) {
    if (pointerY === null) return;
    const delta = pointerY - event.clientY;
    if (Math.abs(delta) < 4) return;
    moved = true;
    pointerY = event.clientY;
    move(delta);
  }
  function pointerEnd() {
    pointerY = null;
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
    pointerEnd();
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
    touchMove,
    pointerDown,
    pointerMove,
    pointerEnd,
    enter,
    leave,
    allowClick,
  };
}
