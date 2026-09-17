import { effectScope, nextTick, ref, watch } from "vue";
import { describe, expect, it } from "vitest";
import { findTimeBucket, useStageClock } from "./useStageClock";

// src/components/LyricStage/useStageClock.test.ts — 验证帧内去重、跳转及预热边界。
describe("stage clock", () => {
  it("finds a boundary bucket including the exact start", () => {
    expect(findTimeBucket([1000, 2000], 999)).toBe(0);
    expect(findTimeBucket([1000, 2000], 1000)).toBe(1);
    expect(findTimeBucket([1000, 2000], 2001)).toBe(2);
  });

  it("does not publish every frame, but follows word endings, seeks and line replacement", async () => {
    const scope = effectScope();
    const clock = ref(1100);
    const lines = ref([
      { startTime: 1000, endTime: 3000, words: [{ startTime: 1000, endTime: 2000 }] },
    ]);
    const updates: number[] = [];
    const sampled = scope.run(() => {
      const time = useStageClock(() => lines.value, clock);
      watch(time, (value) => updates.push(value));
      return time;
    })!;
    try {
      for (const time of [1116, 1132, 1148, 1500, 1999, 2000]) {
        clock.value = time;
        await nextTick();
      }
      expect(updates).toEqual([]);
      clock.value = 2001;
      await nextTick();
      expect(sampled.value).toBe(2001);
      clock.value = 1100;
      await nextTick();
      expect(sampled.value).toBe(1100);
      clock.value = 1500;
      await nextTick();
      lines.value = [{ startTime: 1400, endTime: 4000, words: [] }];
      await nextTick();
      expect(sampled.value).toBe(1500);
    } finally {
      scope.stop();
    }
  });

  it("publishes preheat and long interlude boundaries", async () => {
    const scope = effectScope();
    const clock = ref(5000);
    const sampled = scope.run(() =>
      useStageClock(
        () => [
          { startTime: 4000, endTime: 5000, words: [] },
          { startTime: 10000, endTime: 12000, words: [] },
        ],
        clock,
      ),
    )!;
    try {
      for (const time of [6201, 8500, 8800, 10000]) {
        clock.value = time;
        await nextTick();
        expect(sampled.value).toBe(time);
      }
    } finally {
      scope.stop();
    }
  });
});
