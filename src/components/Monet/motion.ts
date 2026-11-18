import type { LineStatus } from "./model";
import {
  MONET_SCROLL_SPRING,
  MONET_SCALE_SPRING,
  resolveMonetGlow,
  resolveMonetTone,
} from "@/components/LyricDom/vendor/components/visualizer/monet/monetLyricMotion";

// 弹簧积分由 Vue 宿主维护，视觉包络与色调参数直接复用固定上游算法。
export const SCROLL_SPRING = MONET_SCROLL_SPRING;
export const SCALE_SPRING = MONET_SCALE_SPRING;
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export function resolveGlow(time: number, start: number, end: number, lineEnd: number) {
  return resolveMonetGlow(time / 1000, start / 1000, end / 1000, lineEnd / 1000);
}
export function resolveTone(status: LineStatus, offset: number) {
  const tone = resolveMonetTone(status, offset);
  return { opacity: tone.alpha, scale: tone.scale, blur: tone.blur };
}

export interface SpringValue {
  value: number;
  velocity: number;
}
export function stepSpring(
  state: SpringValue,
  target: number,
  delta: number,
  spring = SCROLL_SPRING,
) {
  // 分步积分，低帧率或恢复窗口时也不产生过冲爆炸。
  let remaining = Math.min(delta, 0.064);
  while (remaining > 0) {
    const dt = Math.min(remaining, 1 / 120);
    state.velocity +=
      (((target - state.value) * spring.stiffness - state.velocity * spring.damping) /
        spring.mass) *
      dt;
    state.value += state.velocity * dt;
    remaining -= dt;
  }
  const settled = Math.abs(target - state.value) < 0.01 && Math.abs(state.velocity) < 0.01;
  if (settled) {
    state.value = target;
    state.velocity = 0;
  }
  return settled;
}
