import { describe, expect, it } from "vitest";
import { adaptPartitaLines } from "@/components/Partita/model";
import { buildLineGraphemeTimeline } from "./vendor/utils/lyrics/graphemeTiming";
import { compileHanabiProgram } from "./vendor/components/visualizer/hanabi/hanabiProgram";
import { compileLumiereProgram } from "./vendor/components/visualizer/lumiere/lumiereProgram";
import { adaptPVLines } from "./model";

// 验证毫秒歌词跨进原版秒级分镜后的时序、普通歌词行为和无歌词场景。
const source = [
  {
    startTime: 2000,
    endTime: 4200,
    words: [
      { word: "你好", startTime: 2000, endTime: 3000 },
      { word: " world", startTime: 3000, endTime: 4200 },
    ],
    translatedLyric: "Hello world",
    romanLyric: "ni hao",
  },
  {
    startTime: 9000,
    endTime: 12000,
    words: [{ word: "一起唱歌", startTime: 9000, endTime: 12000 }],
  },
];

describe("PV lyric adapter", () => {
  it("preserves actual word timing and subtitles while removing generated interlude markers", () => {
    const input = adaptPartitaLines(source, true, 16000);
    const lines = adaptPVLines(input);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      startTime: 2,
      endTime: 4.2,
      fullText: "你好 world",
      translation: "Hello world",
      romanization: "ni hao",
    });
    const glyphs = buildLineGraphemeTimeline(lines[0]);
    expect(
      glyphs
        .filter((glyph) => glyph.char.trim())
        .map((glyph) => glyph.char)
        .join(""),
    ).toBe("你好world");
    expect(glyphs[0].startTime).toBe(2);
    expect(glyphs.at(-1)?.endTime).toBe(4.2);
    expect(input[0].startTime).toBe(2000);
  });

  it.each([false, true])(
    "does not invent karaoke timing for line-timed lyrics (animation %s)",
    (animation) => {
      const [line] = adaptPVLines(adaptPartitaLines(source, false), animation);
      expect(
        buildLineGraphemeTimeline(line).every(
          (glyph) => glyph.startTime === 2 && glyph.endTime === 2,
        ),
      ).toBe(true);
      expect(line.endTime).toBe(4.2);
    },
  );

  it("disables word sweeps without losing the actual line duration", () => {
    const [line] = adaptPVLines(adaptPartitaLines(source, true), false);
    expect(line.words.every((word) => word.startTime === 2 && word.endTime === 2)).toBe(true);
    expect(line.endTime).toBe(4.2);
  });
});

for (const [name, compile] of [
  ["hanabi", compileHanabiProgram],
  ["lumiere", compileLumiereProgram],
] as const) {
  describe(`${name} program integration`, () => {
    it("covers intro, gaps and outro using the real song duration in seconds", () => {
      const lines = adaptPVLines(adaptPartitaLines(source, true, 16000));
      const program = compile(lines, "test-song", {}, { duration: 16 });
      expect(program.duration).toBe(16);
      expect(program.paragraphs[0].startTime).toBe(0);
      expect(program.paragraphs.at(-1)?.endTime).toBe(16);
      for (let index = 1; index < program.paragraphs.length; index++) {
        expect(program.paragraphs[index].startTime).toBe(program.paragraphs[index - 1].endTime);
      }
      expect(compile(lines, "test-song", {}, { duration: 16 })).toEqual(program);
    });

    it("renders instrumental scenes without fabricating lyric text", () => {
      const program = compile([], "instrumental", {}, { duration: 60 });
      expect(program.instrumental).toBe(true);
      expect(program.duration).toBe(60);
      expect(program.paragraphs.every((paragraph) => paragraph.lines.length === 0)).toBe(true);
    });
  });
}
