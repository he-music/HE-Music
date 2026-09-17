import { describe, expect, it } from "vitest";
import { adaptClassicLines } from "../Classic/model";
import { adaptPartitaLines } from "./model";
import { getOrBuildPartitaLayout } from "./layout";

// src/components/Partita/timing.test.ts — 两种舞台歌词的时间契约与缓存回归。
describe.each([
  ["Classic", adaptClassicLines],
  ["Partita", adaptPartitaLines],
] as const)("%s untimed lyrics", (_, adapt) => {
  it.each([200, 4000])("keeps every layout token on the line interval (%ims)", (duration) => {
    const [line] = adapt(
      [
        {
          startTime: 1000,
          endTime: 1000 + duration,
          words: [{ word: "让每一个字随音乐轻轻发光", startTime: 1000, endTime: 1000 + duration }],
        },
      ],
      false,
    );
    expect(line.timed).toBe(false);
    expect(line.words.length).toBeGreaterThan(1);
    for (const word of line.words) {
      expect(word.startTime).toBe(1000);
      expect(word.endTime).toBe(1000 + duration);
      expect(word.graphemes).toEqual([]);
    }
  });

  it("falls back to line timing when word timing is unavailable", () => {
    const [line] = adapt(
      [
        {
          startTime: 1000,
          endTime: 3000,
          words: [{ word: "让每一个字随音乐轻轻发光", startTime: 0, endTime: 0 }],
        },
      ],
      true,
    );
    expect(line.timed).toBe(false);
    expect(line.words.every((word) => word.startTime === 1000 && word.endTime === 3000)).toBe(true);
  });
});

describe("Partita layout cache", () => {
  it("refreshes word timing even when line text, duration and word count are unchanged", () => {
    const makeLine = (split: number) =>
      adaptPartitaLines(
        [
          {
            startTime: 1000,
            endTime: 5000,
            words: [
              { word: "Hello ", startTime: 1000, endTime: split },
              { word: "World", startTime: split, endTime: 5000 },
            ],
          },
        ],
        true,
      )[0];
    const first = getOrBuildPartitaLayout(makeLine(2000), 500);
    const revisedLine = makeLine(4000);
    const revised = getOrBuildPartitaLayout(revisedLine, 500);
    expect(revised).not.toBe(first);
    expect(revised.chunks.flatMap((chunk) => chunk.chunkWords.map((word) => word.endTime))).toEqual(
      [4000, 5000],
    );
    expect(getOrBuildPartitaLayout(revisedLine, 500)).toBe(revised);
  });
});
