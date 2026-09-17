import { computed, shallowRef, watch, type Ref } from "vue";

// src/components/LyricStage/useStageClock.ts — 舞台状态只在行、词或预热边界变化时更新。
interface StageLine {
  startTime: number;
  endTime: number;
  words: { startTime: number; endTime: number }[];
}

export function findTimeBucket(boundaries: number[], time: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (boundaries[mid] <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 保留原有预热和 inclusive 词尾语义；扫光另订阅原始时钟。 */
export function useStageClock(lines: () => StageLine[], clock: Readonly<Ref<number>>) {
  const boundaries = computed(() =>
    [
      ...new Set(
        lines().flatMap((line) => [
          line.startTime - 1500,
          line.startTime - 1200,
          line.startTime,
          line.endTime,
          line.endTime + 0.001,
          line.endTime + 1200.001,
          ...line.words.flatMap((word) => [
            word.startTime - 150,
            word.startTime - 120,
            word.startTime,
            word.endTime + 0.001,
          ]),
        ]),
      ),
    ].sort((a, b) => a - b),
  );
  const time = shallowRef(clock.value);
  let bucket = -1;
  watch(
    boundaries,
    () => {
      bucket = findTimeBucket(boundaries.value, clock.value);
      time.value = clock.value;
    },
    { immediate: true },
  );
  watch(clock, (value) => {
    const next = findTimeBucket(boundaries.value, value);
    if (next === bucket) return;
    bucket = next;
    time.value = value;
  });
  return time;
}
