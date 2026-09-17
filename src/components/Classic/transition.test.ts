import { describe, expect, it } from "vitest";
import {
  resolveClassicTransitionMode,
  resolveClassicEnterDuration,
  shouldSkipClassicEnter,
} from "./transition";
import type { ClassicLine } from "./types";

// src/components/Classic/transition.test.ts — Folia 短句分档与跳转后立即显现的回归。
const line: ClassicLine = {
  key: "test",
  text: "开始唱",
  startTime: 2000,
  endTime: 4000,
  timed: true,
  words: [
    { text: "开始", startTime: 2000, endTime: 2100, graphemes: [] },
    { text: "唱", startTime: 2100, endTime: 4000, graphemes: [] },
  ],
};

describe("Classic line transitions", () => {
  it.each([
    [80, "none"],
    [99, "none"],
    [100, "fast"],
    [179, "fast"],
    [180, "normal"],
    [2000, "normal"],
  ] as const)("uses Folia's transition tier for a %ims line", (duration, expected) => {
    expect(resolveClassicTransitionMode({ ...line, endTime: line.startTime + duration })).toBe(
      expected,
    );
  });

  it("finishes the line fade before a short first word has elapsed", () => {
    expect(resolveClassicEnterDuration(line, 2000)).toBe(50);
    expect(resolveClassicEnterDuration(line, 2016)).toBe(42);
    expect(resolveClassicEnterDuration(line, 2150)).toBe(0);
    expect(resolveClassicEnterDuration({ ...line, endTime: 2080 }, 2000)).toBe(0);
    expect(
      resolveClassicEnterDuration(
        {
          ...line,
          words: [{ ...line.words[0], endTime: 2080 }, line.words[1]],
        },
        2000,
      ),
    ).toBe(0);
  });

  it("keeps entry motion for preheat and an on-time line start", () => {
    expect(shouldSkipClassicEnter(line, 1800)).toBe(false);
    expect(shouldSkipClassicEnter(line, 2016)).toBe(false);
  });

  it("skips entry if the first word has already elapsed", () => {
    expect(shouldSkipClassicEnter(line, 2100)).toBe(true);
    expect(shouldSkipClassicEnter(line, 3000)).toBe(true);
  });

  it("also reveals long untimed lines immediately after seeking into the middle", () => {
    const untimed = { ...line, timed: false, words: [{ ...line.words[0], endTime: 4000 }] };
    expect(shouldSkipClassicEnter(untimed, 2500)).toBe(true);
  });
});
