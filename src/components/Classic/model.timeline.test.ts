import { describe, expect, it } from "vitest";
import { adaptClassicLines } from "./model";

describe("Classic timeline regression", () => {
  it("keeps legacy field precedence, simultaneous keys, and the last-line fallback", () => {
    const rows = adaptClassicLines([
      { content: "主唱", time: 1000 },
      { text: "和声", startTime: 1000, time: 1500 },
      { content: "末句", time: 2000 },
    ]);
    expect(rows.map(({ key, startTime, endTime }) => ({ key, startTime, endTime }))).toEqual([
      { key: "0:1000", startTime: 1000, endTime: 2000 },
      { key: "1:1000", startTime: 1000, endTime: 2000 },
      { key: "2:2000", startTime: 2000, endTime: 6000 },
    ]);
  });

  it.each([undefined, 0, -1, NaN, 1000, 9000])(
    "keeps last-line duration fallback for %s",
    (duration) => {
      const [row] = adaptClassicLines([{ content: "歌", time: 1000 }], false, duration);
      expect(row.endTime).toBe(duration && duration > 1000 ? duration : 5000);
    },
  );

  it("preserves NaN, infinity and negative-time behavior", () => {
    const [negative] = adaptClassicLines([{ content: "歌", time: -100 }]);
    expect(negative).toMatchObject({ key: "0:0", startTime: 0, endTime: 4000 });
    const [invalid] = adaptClassicLines([{ content: "歌", startTime: NaN, time: 1000 }]);
    expect(invalid).toMatchObject({ key: "0:NaN", startTime: NaN, endTime: NaN });
    const infinite = adaptClassicLines([{ content: "歌", time: Infinity }]).find(
      (row) => !row.isInterlude,
    );
    expect(infinite).toMatchObject({ key: "0:Infinity", startTime: Infinity, endTime: Infinity });
    const [negativeInfinity] = adaptClassicLines([{ content: "歌", time: -Infinity }]);
    expect(negativeInfinity).toMatchObject({ key: "0:0", startTime: 0, endTime: 4000 });
  });

  it("keeps numeric legacy timestamps compatible with numeric strings", () => {
    const rows = adaptClassicLines([
      { content: "一", time: "1" },
      { content: "二", time: "2" },
      { content: "三", time: "10" },
    ]);
    expect(rows.map((row) => row.endTime)).toEqual([2, 10, 4010]);
  });

  it("preserves explicit ends, legacy word durations and NaN end fallback", () => {
    const input = [
      { time: 100, endTime: 400, words: [{ content: "一", time: 100, duration: 100 }] },
      { time: 200, words: [{ text: "二", time: 200, duration: 300 }] },
      { time: 250, endTime: NaN, words: [{ word: "三", startTime: 250, endTime: NaN }] },
    ];
    expect(adaptClassicLines(input, true).map((row) => row.endTime)).toEqual([400, 500, 4250]);
    expect(adaptClassicLines(input, false).map((row) => row.endTime)).toEqual([400, 250, 4250]);
  });
});
