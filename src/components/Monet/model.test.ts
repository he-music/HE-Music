import { describe, expect, it } from "vitest";
import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import { adaptMonetLines, lyricSeekTime, resolveMonetFrame } from "./model";
import { resolveGlow, stepSpring } from "./motion";

// src/components/Monet/model.test.ts — 歌词时间边界、降级、和声及动画跳转行为。
const line = (
  start: number,
  end: number,
  text: string,
  extra: Partial<LyricLine> = {},
): LyricLine => ({
  startTime: start,
  endTime: end,
  words: [{ word: text, startTime: start, endTime: end }],
  translatedLyric: "translation",
  romanLyric: "romanization",
  isBG: false,
  isDuet: false,
  ...extra,
});
describe("Monet lyric adaptation", () => {
  it("keeps text, spaces, graphemes and exact millisecond word bounds", () => {
    const [result] = adaptMonetLines([line(100, 1000, "你 👨‍👩‍👧‍👦é")], true);
    expect(result.words[0].glyphs.map((glyph) => glyph.text)).toEqual(["你", " ", "👨‍👩‍👧‍👦", "é"]);
    expect(result.words[0].glyphs[0].start).toBe(100);
    expect(result.words[0].glyphs.at(-1)?.end).toBe(1000);
    expect(result.text).toBe("你 👨‍👩‍👧‍👦é");
    expect(result.translation).toBe("translation");
    expect(result.romanization).toBe("romanization");
  });
  it("never treats LRC as word-timed and infers missing line ends", () => {
    const result = adaptMonetLines([line(0, 0, "first"), line(4000, 0, "last")], false, 9000);
    expect(result.map((row) => row.timed)).toEqual([false, false]);
    expect(result.map((row) => row.end)).toEqual([4000, 9000]);
    expect(resolveMonetFrame(result, 0).statuses).toEqual(["active", "waiting"]);
    expect(resolveMonetFrame(result, 4000).statuses).toEqual(["passed", "active"]);
  });
  it("keeps simultaneous background vocals without stealing the main anchor", () => {
    const rows = adaptMonetLines(
      [
        line(2000, 6000, "main"),
        line(2500, 5500, "harmony", { isBG: true, isDuet: true }),
        line(9000, 12000, "next"),
      ],
      true,
    );
    expect(resolveMonetFrame(rows, 3000)).toEqual({
      anchor: 0,
      statuses: ["active", "active", "waiting"],
    });
    expect(rows[1]).toMatchObject({ background: true, duet: true });
    expect(resolveMonetFrame(rows, 7000).anchor).toBe(2);
    expect(resolveMonetFrame(rows, 13000).statuses).toEqual(["passed", "passed", "passed"]);
    expect(resolveMonetFrame(rows, 1000).statuses).toEqual(["waiting", "waiting", "waiting"]);
  });
  it("sorts without mutating source data and removes empty lines", () => {
    const source = [line(2000, 3000, "later"), line(0, 1000, "first"), line(1000, 1500, " ")];
    expect(adaptMonetLines(source, true).map((row) => row.text)).toEqual(["first", "later"]);
    expect(source[0].words[0].word).toBe("later");
  });
  it("applies positive and negative offsets exactly once including time zero", () => {
    expect(lyricSeekTime(2000, 500)).toBe(1500);
    expect(lyricSeekTime(2000, -500)).toBe(2500);
    expect(lyricSeekTime(0, 500)).toBe(0);
  });
});
describe("Monet motion", () => {
  it("uses absolute time for glow so seeking backwards restores the waiting state", () => {
    expect(resolveGlow(1500, 1000, 2000, 4000)).toBeGreaterThan(0);
    expect(resolveGlow(5000, 1000, 2000, 4000)).toBe(0);
    expect(resolveGlow(500, 1000, 2000, 4000)).toBe(0);
  });
  it("settles safely after long frame delays", () => {
    const state = { value: -200, velocity: 0 };
    for (let i = 0; i < 300; i++) stepSpring(state, 100, i === 0 ? 30 : 1 / 60);
    expect(state.value).toBe(100);
    expect(state.velocity).toBe(0);
  });
});
