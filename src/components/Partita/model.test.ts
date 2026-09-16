import { describe, expect, it } from "vitest";
import { adaptPartitaLines, buildWordGraphemeTimings, splitLyricGraphemes } from "./model";

describe("Partita visualizer model", () => {
  it("splits graphemes correctly", () => {
    expect(splitLyricGraphemes("你好")).toEqual(["你", "好"]);
    expect(splitLyricGraphemes("")).toEqual([]);
  });

  it("builds grapheme timings", () => {
    const timings = buildWordGraphemeTimings("测试", 1000, 2000);
    expect(timings).toHaveLength(2);
    expect(timings[0]).toEqual({ char: "测", startTime: 1000, endTime: 1500 });
    expect(timings[1]).toEqual({ char: "试", startTime: 1500, endTime: 2000 });
  });

  it("adapts lines with wordTimed=true", () => {
    const raw = [
      {
        startTime: 1000,
        endTime: 3000,
        words: [
          { word: "云", startTime: 1000, endTime: 2000 },
          { word: "阶", startTime: 2000, endTime: 3000 },
        ],
      },
    ];
    const lines = adaptPartitaLines(raw, true, 5000);
    expect(lines).toHaveLength(1);
    expect(lines[0].timed).toBe(true);
    expect(lines[0].words).toHaveLength(2);
  });

  it("adapts lines with wordTimed=false as a single unified line unit", () => {
    const raw = [
      {
        startTime: 1000,
        endTime: 3000,
        words: [
          { word: "云", startTime: 1000, endTime: 2000 },
          { word: "阶", startTime: 2000, endTime: 3000 },
        ],
      },
    ];
    const lines = adaptPartitaLines(raw, false, 5000);
    expect(lines).toHaveLength(1);
    expect(lines[0].timed).toBe(false);
    expect(lines[0].words).toHaveLength(1);
    expect(lines[0].words[0].text).toBe("云阶");
    expect(lines[0].words[0].startTime).toBe(1000);
    expect(lines[0].words[0].endTime).toBe(3000);
  });
});
