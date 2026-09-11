import type { LineStatus } from "./model";

// src/components/Monet/motion.ts
// Adapted from Folia (chthollyphile), AGPL-3.0: monetLyricMotion.ts / MonetLyricsRail.tsx.
// https://github.com/chthollyphile/folia-major
export const SCROLL_SPRING = { stiffness: 142, damping: 28, mass: 0.82 };
export const SCALE_SPRING = { stiffness: 150, damping: 30, mass: 0.78 };
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Folia 的绝对时间辉光包络，输入统一为毫秒，暂停或跳转不依赖动画累计时间。 */
export function resolveGlow(time: number, start: number, end: number, lineEnd: number) {
  if (time <= start) return 0;
  const peak = start + Math.max(1, end - start) * 1.18;
  const tail = Math.max(lineEnd, end + 1050);
  const progress =
    time <= peak
      ? clamp((time - start) / (peak - start))
      : 1 - clamp((time - peak) / Math.max(180, tail - peak));
  return progress * progress * (3 - 2 * progress);
}

export function resolveTone(status: LineStatus, offset: number) {
  if (status === "active") return { opacity: 1, scale: 1, blur: 0 };
  const distance = Math.max(Math.abs(offset), 1);
  const waiting = status === "waiting";
  return {
    opacity: waiting
      ? clamp(0.72 - (distance - 1) * 0.18, 0.36, 0.72)
      : clamp(0.52 - (distance - 1) * 0.12, 0.28, 0.52),
    scale: clamp(0.78 * Math.pow(0.9, distance - 1), 0.68, 0.92),
    blur: waiting
      ? distance === 1
        ? 0.7
        : 1.8 + (distance - 2) * 0.8
      : 1.1 + (distance - 1) * 0.7,
  };
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
