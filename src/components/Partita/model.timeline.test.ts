import { describe, expect, it } from "vitest";
import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import { adaptPartitaLines } from "./model";

const line = (startTime: number, extra: Partial<LyricLine> = {}): LyricLine => ({
  startTime,
  endTime: 0,
  words: [{ word: "歌", startTime, endTime: 0 }],
  translatedLyric: "",
  romanLyric: "",
  isBG: false,
  isDuet: false,
  ...extra,
});

describe("Partita timeline regression", () => {
  it("keeps simultaneous vocal keys and infers their ends from the next distinct start", () => {
    const rows = adaptPartitaLines(
      [line(1000), line(1000, { isBG: true, isDuet: true }), line(2000)],
      false,
    );
    expect(rows.map(({ key, startTime, endTime }) => ({ key, startTime, endTime }))).toEqual([
      { key: "0:1000", startTime: 1000, endTime: 2000 },
      { key: "1:1000", startTime: 1000, endTime: 2000 },
      { key: "2:2000", startTime: 2000, endTime: 7000 },
    ]);
    expect(rows[1]).toMatchObject({ background: true, duet: true });
  });

  it.each([0, -1, NaN, 1000, 9000])("keeps last-line duration fallback for %s", (duration) => {
    const [row] = adaptPartitaLines([line(1000)], false, duration);
    expect(row.endTime).toBe(duration > 1000 ? duration : 6000);
  });

  it("retains finite fallbacks for negative and non-finite line and word times", () => {
    for (const startTime of [-100, NaN, Infinity, -Infinity]) {
      const [row] = adaptPartitaLines([line(startTime, { endTime: NaN })], false);
      expect(row).toMatchObject({ key: "0:0", startTime: 0, endTime: 5000, timed: false });
    }
    const [row] = adaptPartitaLines(
      [line(100, { endTime: NaN, words: [{ word: "歌", startTime: NaN, endTime: Infinity }] })],
      true,
    );
    expect(row.endTime).toBe(5100);
    expect(row.words[0]).toMatchObject({ startTime: 100, endTime: 5100, graphemes: [] });
  });

  it("preserves explicit and word ends beyond the next line", () => {
    const input = [
      line(100, { endTime: 300 }),
      line(200, { words: [{ word: "歌", startTime: 200, endTime: 500 }] }),
      line(250),
    ];
    expect(adaptPartitaLines(input, true).map((row) => row.endTime)).toEqual([300, 500, 5250]);
    expect(adaptPartitaLines(input, false).map((row) => row.endTime)).toEqual([300, 250, 5250]);
  });
});
