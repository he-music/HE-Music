import type { ClassicLine } from "./types";

// src/components/Classic/transition.ts — Adapted from Folia (AGPL-3.0),
// utils/lyrics/renderHints.ts and classic/Visualizer.tsx; seconds converted to milliseconds.
export type ClassicTransitionMode = "normal" | "fast" | "none";

export function resolveClassicTransitionMode(line: ClassicLine): ClassicTransitionMode {
  const duration = Math.max(0, line.endTime - line.startTime);
  if (duration < 100) return "none";
  if (duration < 180) return "fast";
  return "normal";
}

/** 入场必须在首词前半段完成，避免正常长句中的短促句首仍被淡入遮住。 */
export function resolveClassicEnterDuration(line: ClassicLine, time: number): number {
  if (shouldSkipClassicEnter(line, time)) return 0;
  const mode = resolveClassicTransitionMode(line);
  const duration = mode === "none" ? 0 : mode === "fast" ? 160 : 300;
  const firstWord = line.words.find((word) => word.text.trim());
  if (firstWord && firstWord.endTime - Math.max(line.startTime, firstWord.startTime) < 100)
    return 0;
  const remaining = Math.max(
    0,
    (firstWord?.endTime ?? line.endTime) - Math.max(line.startTime, time),
  );
  return Math.min(duration, remaining / 2);
}

/** 跳入句中时不要重放整行入场，保留按当前时钟计算的词状态。 */
export function shouldSkipClassicEnter(line: ClassicLine, time: number): boolean {
  const firstWord = line.words.find((word) => word.text.trim());
  const firstRevealEnd = Math.min(firstWord?.endTime ?? line.endTime, line.startTime + 200);
  return time >= firstRevealEnd;
}
