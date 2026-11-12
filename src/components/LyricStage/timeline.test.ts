import { describe, expect, it } from "vitest";
import { buildNextLaterStarts } from "./timeline";

const normalizeFiniteStart = (start: number) => Math.max(0, Number.isFinite(start) ? start : 0);
const normalizeClassicStart = (start: number) => Math.max(0, start);

describe("buildNextLaterStarts", () => {
  it("skips simultaneous starts and leaves the final group without a later start", () => {
    expect(buildNextLaterStarts([0, 0, 1000, 1000], normalizeFiniteStart)).toEqual([
      1000,
      1000,
      undefined,
      undefined,
    ]);
    expect(buildNextLaterStarts([], normalizeFiniteStart)).toEqual([]);
  });

  it("uses the first later match in source order even across invalid or unsorted times", () => {
    const starts = [100, NaN, 300, 200, Infinity, -10];
    expect(buildNextLaterStarts(starts, normalizeFiniteStart)).toEqual([
      300,
      300,
      Infinity,
      Infinity,
      undefined,
      undefined,
    ]);
    expect(buildNextLaterStarts(starts, normalizeClassicStart)).toEqual([
      300,
      undefined,
      Infinity,
      Infinity,
      undefined,
      undefined,
    ]);
  });

  it("matches the former slice/find lookup for deterministic combinations and both normalizers", () => {
    const values = [-Infinity, -10, -0, 0, 0.5, 100, 300, Infinity, NaN];
    for (const normalizeStart of [normalizeFiniteStart, normalizeClassicStart]) {
      for (let sample = 0; sample < values.length ** 4; sample++) {
        let remaining = sample;
        const starts = Array.from({ length: 4 }, () => {
          const value = values[remaining % values.length];
          remaining = Math.floor(remaining / values.length);
          return value;
        });
        for (const source of [starts, [...starts].sort((a, b) => a - b)]) {
          const expected = source.map((start, index) =>
            source.slice(index + 1).find((candidate) => candidate > normalizeStart(start)),
          );
          expect(buildNextLaterStarts(source, normalizeStart)).toEqual(expected);
        }
      }
    }
  });

  it("handles a long simultaneous group without recursive traversal", () => {
    const starts = [...Array<number>(20000).fill(100), 200];
    const nextStarts = buildNextLaterStarts(starts, normalizeFiniteStart);
    expect(nextStarts.slice(0, -1).every((start) => start === 200)).toBe(true);
    expect(nextStarts.at(-1)).toBeUndefined();
  });
});
