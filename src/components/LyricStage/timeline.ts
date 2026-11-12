/**
 * 按原顺序寻找后续首个严格晚于行起点的时间，不要求 NaN 参与排序后仍然有序。
 * normalizeStart 须将负值钳制到 0，且仅可额外将非有限值回退到 0。
 * 非正值不可能成为候选；逆向单调栈中每个候选至多入栈、出栈一次。
 */
export function buildNextLaterStarts(
  starts: readonly number[],
  normalizeStart: (start: number) => number,
): (number | undefined)[] {
  const nextStarts = new Array<number | undefined>(starts.length);
  const candidates: number[] = [];
  for (let index = starts.length - 1; index >= 0; index--) {
    const rawStart = starts[index];
    const start = normalizeStart(rawStart);
    while (candidates.length && candidates[candidates.length - 1] <= start) {
      candidates.pop();
    }
    nextStarts[index] = Number.isNaN(start) ? undefined : candidates[candidates.length - 1];
    if (rawStart > 0) {
      while (candidates.length && candidates[candidates.length - 1] <= Number(rawStart)) {
        candidates.pop();
      }
      candidates.push(rawStart);
    }
  }
  return nextStarts;
}
