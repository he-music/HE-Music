import { describe, expect, it } from "vitest";
import { adaptClassicLines, resolveActiveLineIndex } from "../Classic/model";
import { adaptPartitaLines, resolvePartitaFrame } from "../Partita/model";
import { buildSequentialChunks } from "../Partita/layout";
import { adaptMonetLines, resolveMonetFrame } from "../Monet/model";
import { insertInterludes } from "./interludes";

// src/components/LyricStage/interludes.test.ts — 六点前奏、长间奏和正常歌词边界。
const source = [
  {
    startTime: 5000,
    endTime: 7000,
    words: [{ word: "第一句", startTime: 5000, endTime: 7000 }],
    translatedLyric: "",
    romanLyric: "",
    isBG: false,
    isDuet: false,
  },
  {
    startTime: 12000,
    endTime: 15000,
    words: [{ word: "第二句", startTime: 12000, endTime: 15000 }],
    translatedLyric: "",
    romanLyric: "",
    isBG: false,
    isDuet: false,
  },
];

describe("Folia interludes", () => {
  it("inserts six separately timed dots with Folia's millisecond margins", () => {
    const lines = adaptClassicLines(source, true);
    expect(lines.map((line) => line.text)).toEqual(["......", "第一句", "......", "第二句"]);
    expect([lines[0].startTime, lines[0].endTime]).toEqual([500, 4500]);
    expect([lines[2].startTime, lines[2].endTime]).toEqual([7050, 11950]);
    for (const line of [lines[0], lines[2]]) {
      expect(line.words).toHaveLength(6);
      expect(line.words.map((word) => word.text).join("")).toBe("......");
      expect(line.words[0].startTime).toBe(line.startTime);
      expect(line.words[5].endTime).toBe(line.endTime);
      expect(line.words.every((word) => word.endTime > word.startTime)).toBe(true);
    }
    expect(source).toHaveLength(2);
    expect(lines[resolveActiveLineIndex(lines, 9000)].isInterlude).toBe(true);
    expect(lines[resolveActiveLineIndex(lines, 12000)].text).toBe("第二句");
  });

  it("uses the same interlude in Partita and Monet", () => {
    const partita = adaptPartitaLines(source, true);
    const frame = resolvePartitaFrame(partita, 9000);
    expect(frame.activeLine?.isInterlude).toBe(true);
    expect(frame.upcomingLine?.fullText).toBe("第二句");
    expect(buildSequentialChunks(frame.activeLine!, 500).chunks[0].displayWords).toHaveLength(6);
    const monet = adaptMonetLines(source, true);
    const current = monet[resolveMonetFrame(monet, 9000).anchor];
    expect(current.text).toBe("......");
    expect(current.words).toHaveLength(6);
    expect(current.words[5].glyphs[0].end).toBe(11950);
  });

  it("animates interludes even when the original lyrics only have line timing", () => {
    const lines = adaptClassicLines(source, false);
    expect(lines[0].timed).toBe(true);
    expect(lines[1].timed).toBe(false);
    expect(lines[2].timed).toBe(true);
  });

  it("does not insert dots for empty lyrics or gaps of exactly three seconds", () => {
    expect(adaptClassicLines([], true)).toEqual([]);
    expect(adaptPartitaLines([], true)).toEqual([]);
    expect(adaptMonetLines([], true)).toEqual([]);
    const lines = adaptClassicLines([
      { content: "A", startTime: 3000, endTime: 4000 },
      { content: "B", startTime: 7000, endTime: 8000 },
    ]);
    expect(lines.map((line) => line.text)).toEqual(["A", "B"]);
  });

  it("does not insert dots over overlapping vocals or append them at the song end", () => {
    const lines = [
      { startTime: 0, endTime: 10000 },
      { startTime: 1000, endTime: 2000 },
      { startTime: 8000, endTime: 9000 },
    ];
    expect(
      insertInterludes(
        lines,
        (line) => line,
        (line) => line,
      ),
    ).toEqual(lines);
  });
});
