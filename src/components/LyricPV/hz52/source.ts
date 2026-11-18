import type { Line } from "../vendor/types";

// 歌词间奏停止发射新年轮，已发出的年轮继续扩散；每帧只做二分定位。
export function find52HzLineIndex(lines: Line[], time: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startTime <= time) lo = mid + 1;
    else hi = mid;
  }
  const index = lo - 1;
  const line = lines[index];
  return line && time < line.endTime && line.fullText.trim() ? index : -1;
}
