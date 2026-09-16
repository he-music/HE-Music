import { describe, expect, it } from "vitest";
import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import {
  buildPostLyricLayoutUnits,
  buildDisplayWordsFromLayoutUnits,
  applyStickyPunctuationLayoutUnits,
} from "./cjkSemanticLayout";
import { adaptPartitaLines, buildWordGraphemeTimings, resolvePartitaFrame } from "./model";
import { buildSequentialChunks, getOrBuildPartitaLayout } from "./layout";

describe("Partita CJK 语义分词与标点粘滞", () => {
  it("应正确粘滞英文缩写与标点", () => {
    const units = [
      {
        text: "It",
        words: [{ text: "It", startTime: 0, endTime: 200 }],
        startTime: 0,
        endTime: 200,
        isSemantic: false,
      },
      {
        text: "’",
        words: [{ text: "’", startTime: 200, endTime: 250 }],
        startTime: 200,
        endTime: 250,
        isSemantic: false,
      },
      {
        text: "s",
        words: [{ text: "s", startTime: 250, endTime: 400 }],
        startTime: 250,
        endTime: 400,
        isSemantic: false,
      },
    ];
    const merged = applyStickyPunctuationLayoutUnits(units);
    expect(merged.length).toBe(1);
    expect(merged[0].text).toBe("It’s");
    expect(merged[0].isSticky).toBe(true);

    const displayWords = buildDisplayWordsFromLayoutUnits(merged);
    expect(displayWords.length).toBe(1);
    expect(displayWords[0].text).toBe("It’s");
  });

  it("应将中文标点粘滞至前一个词", () => {
    const units = [
      {
        text: "世界",
        words: [{ text: "世界", startTime: 0, endTime: 500 }],
        startTime: 0,
        endTime: 500,
        isSemantic: true,
      },
      {
        text: "。",
        words: [{ text: "。", startTime: 500, endTime: 600 }],
        startTime: 500,
        endTime: 600,
        isSemantic: false,
      },
    ];
    const merged = applyStickyPunctuationLayoutUnits(units);
    expect(merged.length).toBe(1);
    expect(merged[0].text).toBe("世界。");
  });

  it("buildPostLyricLayoutUnits 应处理包含中文的歌词", () => {
    const words = [
      { text: "你", startTime: 0, endTime: 200 },
      { text: "好", startTime: 200, endTime: 400 },
      { text: "，", startTime: 400, endTime: 500 },
      { text: "世界", startTime: 500, endTime: 900 },
    ];
    const units = buildPostLyricLayoutUnits("你好，世界", words, {
      semantic: true,
      sticky: true,
    });
    expect(units.length).toBeGreaterThanOrEqual(1);
  });
});

const createMockLine = (
  startTime: number,
  endTime: number,
  words: { word: string; startTime: number; endTime: number }[],
  extra: Partial<LyricLine> = {},
): LyricLine => ({
  startTime,
  endTime,
  words,
  translatedLyric: "",
  romanLyric: "",
  isBG: false,
  isDuet: false,
  ...extra,
});

describe("Partita 模型转换与字符时序", () => {
  it("拆分多字符词语的时序", () => {
    const timings = buildWordGraphemeTimings("Hello", 0, 1000);
    expect(timings.length).toBe(5);
    expect(timings[0]).toEqual({ char: "H", startTime: 0, endTime: 200 });
    expect(timings[4]).toEqual({ char: "o", startTime: 800, endTime: 1000 });
  });

  it("adaptPartitaLines 能正确将 AMLL 格式转换为 Partita 行", () => {
    const rawLines: LyricLine[] = [
      createMockLine(
        1000,
        3000,
        [
          { word: "Music", startTime: 1000, endTime: 2000 },
          { word: "Life", startTime: 2000, endTime: 3000 },
        ],
        { translatedLyric: "音乐生活" },
      ),
    ];
    const lines = adaptPartitaLines(rawLines, true);
    expect(lines.length).toBe(1);
    expect(lines[0].fullText).toBe("MusicLife");
    expect(lines[0].translation).toBe("音乐生活");
    expect(lines[0].words.length).toBe(2);
    expect(lines[0].words[0].graphemes.length).toBe(5);
  });

  it("resolvePartitaFrame 能快速定位活跃行", () => {
    const lines = adaptPartitaLines(
      [
        createMockLine(1000, 3000, [{ word: "A", startTime: 1000, endTime: 3000 }]),
        createMockLine(4000, 6000, [{ word: "B", startTime: 4000, endTime: 6000 }]),
      ],
      true,
    );
    const frame1 = resolvePartitaFrame(lines, 1500);
    expect(frame1.activeIndex).toBe(0);

    const frame2 = resolvePartitaFrame(lines, 4500);
    expect(frame2.activeIndex).toBe(1);
  });
});

describe("Partita 阶梯排版算法 (layout.ts)", () => {
  it("为单行生成合理的 Chunks 与阶梯交错偏移", () => {
    const lines = adaptPartitaLines(
      [
        createMockLine(1000, 4000, [
          { word: "春风", startTime: 1000, endTime: 1500 },
          { word: "吹又生", startTime: 1500, endTime: 2500 },
          { word: "花落知多少", startTime: 2500, endTime: 4000 },
        ]),
      ],
      true,
    );

    const layout = buildSequentialChunks(lines[0], 600);
    expect(layout.chunks.length).toBeGreaterThanOrEqual(1);

    // 检查是否有交替左右引导线
    if (layout.chunks.length > 1) {
      expect(layout.chunks[0].guidePosition).toBe("left");
      expect(layout.chunks[1].guidePosition).toBe("right");
    }
  });

  it("getOrBuildPartitaLayout 缓存机制命中", () => {
    const lines = adaptPartitaLines(
      [createMockLine(1000, 2000, [{ word: "测试", startTime: 1000, endTime: 2000 }])],
      true,
    );
    const l1 = getOrBuildPartitaLayout(lines[0], 500);
    const l2 = getOrBuildPartitaLayout(lines[0], 500);
    expect(l1).toBe(l2);
  });
});
