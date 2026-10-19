import { describe, expect, it } from "vitest";
import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import { findLyricBoundary, getActiveLyricIndices } from "./timing";
import { calculateLyricIndex } from "../calc";

function line(startTime: number, endTime: number): LyricLine {
  return {
    startTime,
    endTime,
    words: [],
    translatedLyric: "",
    romanLyric: "",
    isBG: false,
    isDuet: false,
  };
}

describe("歌词时间查询", () => {
  it("区分 >= 和 >，保留相同开始时间的边界", () => {
    const lyrics = [line(1000, 2000), line(2000, 3000), line(2000, 4000)];
    expect(findLyricBoundary(lyrics, 0)).toBe(0);
    expect(findLyricBoundary(lyrics, 2000, true)).toBe(1);
    expect(findLyricBoundary(lyrics, 2000)).toBe(3);
    expect(findLyricBoundary(lyrics, 5000)).toBe(3);
    expect(findLyricBoundary([], 1000)).toBe(0);
  });

  it("定位长歌词时只读取对数数量的开始时间", () => {
    let reads = 0;
    const lyrics = Array.from({ length: 10_000 }, (_, i) => ({
      get startTime() {
        reads++;
        return i * 1000;
      },
    }));
    expect(findLyricBoundary(lyrics, 5_000_000)).toBe(5001);
    expect(reads).toBeLessThanOrEqual(14);
  });

  it("激活区间包含句首、不包含句尾，间奏返回空集合", () => {
    const lyrics = [line(1000, 2000), line(3000, 4000)];
    expect(getActiveLyricIndices(lyrics, 999)).toEqual([]);
    expect(getActiveLyricIndices(lyrics, 1000)).toEqual([0]);
    expect(getActiveLyricIndices(lyrics, 2000)).toEqual([]);
    expect(getActiveLyricIndices(lyrics, 3000)).toEqual([1]);
    expect(getActiveLyricIndices(lyrics, 4000)).toEqual([]);
  });

  it("跨过已结束的行继续查找长重叠行，只保留最后几个激活行", () => {
    const lyrics = [
      line(0, 10_000),
      line(1000, 1500),
      line(2000, 9000),
      line(3000, 9000),
      line(4000, 9000),
    ];
    expect(getActiveLyricIndices(lyrics, 5000)).toEqual([0, 2, 3, 4]);
    expect(getActiveLyricIndices(lyrics, 5000, 3)).toEqual([2, 3, 4]);
    expect(getActiveLyricIndices(lyrics, 5000, 2)).toEqual([3, 4]);
    // 后退跳转后不依赖之前的查询状态。
    expect(getActiveLyricIndices(lyrics, 1200, 3)).toEqual([0, 1]);
  });

  it("缺失结束时间视为持续到无限远", () => {
    const lyrics = [{ startTime: 0 }, { startTime: 1000, endTime: 2000 }];
    expect(getActiveLyricIndices(lyrics, 3000)).toEqual([0]);
  });
});

describe("桌面歌词定位兼容性", () => {
  it("保留普通歌词的严格前一句规则、提前量和偏移", () => {
    const lyrics = [line(1000, 0), line(2000, 0), line(3000, Infinity)];
    expect(calculateLyricIndex(699, lyrics)).toBe(-1);
    expect(calculateLyricIndex(700, lyrics)).toBe(-1);
    expect(calculateLyricIndex(701, lyrics)).toBe(0);
    expect(calculateLyricIndex(1700, lyrics)).toBe(0);
    expect(calculateLyricIndex(1701, lyrics)).toBe(1);
    expect(calculateLyricIndex(1501, lyrics, 200)).toBe(1);
    expect(calculateLyricIndex(3000, lyrics)).toBe(2);
  });

  it("保留逐字歌词的句首、间奏和结束定位", () => {
    const lyrics = [line(1000, 2000), line(3000, 4000)];
    expect(calculateLyricIndex(699, lyrics)).toBe(-1);
    expect(calculateLyricIndex(700, lyrics)).toBe(0);
    expect(calculateLyricIndex(2200, lyrics)).toBe(0);
    expect(calculateLyricIndex(2700, lyrics)).toBe(1);
    expect(calculateLyricIndex(3700, lyrics)).toBe(1);
    expect(calculateLyricIndex(0, [])).toBe(-1);
  });

  it("保留两行、三行以及更大保留数量的重叠选择规则", () => {
    const lyrics = [0, 1000, 2000, 3000, 4000, 5000].map((start) => line(start, 10_000));
    expect(calculateLyricIndex(4700, lyrics)).toBe(3);
    expect(calculateLyricIndex(4700, lyrics, 0, 2)).toBe(4);
    expect(calculateLyricIndex(4700, lyrics, 0, 5)).toBe(1);
    expect(calculateLyricIndex(2700, lyrics, 0, 5)).toBe(2);
  });
});
