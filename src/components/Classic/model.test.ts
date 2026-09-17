// src/components/Classic/model.test.ts
import { describe, expect, it } from "vitest";
import {
  adaptClassicLines,
  buildWordGraphemes,
  deterministicRandom,
  lyricSeekTime,
  resolveActiveLineIndex,
  resolveDeterministicWordLayouts,
  resolveWordStatus,
  resolveUpcomingLine,
  splitLyricGraphemes,
} from "./model";

describe("Classic visualizer model", () => {
  it("splits text into graphemes accurately", () => {
    expect(splitLyricGraphemes("Hello")).toEqual(["H", "e", "l", "l", "o"]);
    expect(splitLyricGraphemes("你好世界")).toEqual(["你", "好", "世", "界"]);
    expect(splitLyricGraphemes("")).toEqual([]);
  });

  it("builds grapheme timings with start and end times", () => {
    const graphemes = buildWordGraphemes("歌词", 1000, 2000);
    expect(graphemes).toHaveLength(2);
    expect(graphemes[0]).toEqual({ char: "歌", startTime: 1000, endTime: 1500 });
    expect(graphemes[1]).toEqual({ char: "词", startTime: 1500, endTime: 2000 });
  });

  it("produces deterministic random values for the same seed", () => {
    const v1 = deterministicRandom(12345, 1);
    const v2 = deterministicRandom(12345, 1);
    const v3 = deterministicRandom(12345, 2);
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v1).toBeLessThan(1);
  });

  it("resolves deterministic word layouts for a line", () => {
    const line = {
      key: "line-1",
      text: "测试歌词 流光",
      startTime: 5000,
      endTime: 8000,
      words: [
        { text: "测试歌词", startTime: 5000, endTime: 6500, graphemes: [] },
        { text: "流光", startTime: 6500, endTime: 8000, graphemes: [] },
      ],
      timed: true,
    };

    const layout1 = resolveDeterministicWordLayouts(line, { enableWordRotation: true });
    const layout2 = resolveDeterministicWordLayouts(line, { enableWordRotation: true });

    expect(layout1.wordConfigs).toEqual(layout2.wordConfigs);
    expect(layout1.wordConfigs).toHaveLength(2);
    expect(layout1.wordConfigs[0].scale).toBeGreaterThan(1.0);
    expect(layout1.wordConfigs[0].marginRight).toBeTruthy();

    const noRotate = resolveDeterministicWordLayouts(line, { enableWordRotation: false });
    expect(noRotate.wordConfigs[0].rotate).toBe(0);
    expect(noRotate.wordConfigs[0].passedRotate).toBe(0);

    // 针对移动端小屏（如 390px 视口）：强制安全居中并收拢词间距防越界
    const mobileLayout = resolveDeterministicWordLayouts(
      line,
      { enableWordRotation: true },
      { containerWidth: 390 },
    );
    expect(mobileLayout.lineConfig.justifyContent).toBe("center");
    expect(parseFloat(mobileLayout.wordConfigs[0].marginRight)).toBeLessThan(
      parseFloat(layout1.wordConfigs[0].marginRight),
    );
  });

  it("resolves word status correctly across time", () => {
    const word = { text: "唱", startTime: 2000, endTime: 3000, graphemes: [] };

    // lookahead 默认 120ms
    expect(resolveWordStatus(word, 1500)).toBe("waiting");
    expect(resolveWordStatus(word, 1900)).toBe("active"); // 命中 2000 - 120
    expect(resolveWordStatus(word, 2500)).toBe("active");
    expect(resolveWordStatus(word, 3000)).toBe("active");
    expect(resolveWordStatus(word, 3050)).toBe("passed");
  });

  it("finds active line index across prelude, singing and interlude", () => {
    const lines = [
      { key: "1", text: "A", startTime: 1000, endTime: 2000, words: [], timed: false },
      { key: "2", text: "B", startTime: 4000, endTime: 5000, words: [], timed: false },
      { key: "3", text: "C", startTime: 8000, endTime: 9000, words: [], timed: false },
    ];

    // 较长前奏期（>1200ms）返回 -1 展示等待态
    expect(resolveActiveLineIndex(lines, -500)).toBe(-1);
    // 临近开唱（<=1200ms）预热第 0 句
    expect(resolveActiveLineIndex(lines, 500)).toBe(0);
    expect(resolveActiveLineIndex(lines, 1500)).toBe(0);
    // 间奏期刚唱完（<=1200ms）保持当前句
    expect(resolveActiveLineIndex(lines, 2200)).toBe(0);
    // 距下一句 <= 1200ms 时预热下一句
    expect(resolveActiveLineIndex(lines, 3000)).toBe(1);
    expect(resolveActiveLineIndex(lines, 4500)).toBe(1);
    // 较长间奏期（5000 到 8000 之间，在 6300 时）返回 -1 展示等待态
    expect(resolveActiveLineIndex(lines, 6300)).toBe(-1);
    expect(resolveActiveLineIndex(lines, 8500)).toBe(2);
    // 曲终保持最后一句
    expect(resolveActiveLineIndex(lines, 10000)).toBe(2);
  });

  it("switches to the latest started overlapping line without waiting for the old tail", () => {
    const lines = adaptClassicLines([
      { content: "上一句", startTime: 1000, endTime: 3400 },
      { content: "下一句", startTime: 3000, endTime: 5000 },
    ]);
    expect(resolveActiveLineIndex(lines, 2999)).toBe(0);
    expect(resolveActiveLineIndex(lines, 3000)).toBe(1);
    expect(resolveActiveLineIndex(lines, 3200)).toBe(1);
    expect(resolveActiveLineIndex(lines, 3400)).toBe(1);
    // 回拖必须恢复前一句，选行不能依赖上次播放方向。
    expect(resolveActiveLineIndex(lines, 2500)).toBe(0);
  });

  it("selects contiguous quick lines exactly at their starts", () => {
    const lines = adaptClassicLines([
      { content: "一", startTime: 0, endTime: 2000 },
      { content: "二", startTime: 2000, endTime: 2150 },
      { content: "三", startTime: 2150, endTime: 2230 },
      { content: "四", startTime: 2230, endTime: 4000 },
    ]);
    for (const [index, line] of lines.entries()) {
      expect(resolveActiveLineIndex(lines, line.startTime)).toBe(index);
    }
  });

  it("adapts AMLL lyric format (words[].word & translatedLyric)", () => {
    const amllLyrics = [
      {
        startTime: 1000,
        endTime: 3000,
        translatedLyric: "Hello World",
        romanLyric: "ni hao shi jie",
        words: [
          { word: "你", startTime: 1000, endTime: 1500 },
          { word: "好", startTime: 1500, endTime: 2000 },
          { word: "世界", startTime: 2000, endTime: 3000 },
        ],
      },
    ];

    const adapted = adaptClassicLines(amllLyrics, true, 5000);
    expect(adapted).toHaveLength(1);
    expect(adapted[0].text).toBe("你好世界");
    expect(adapted[0].translation).toBe("Hello World");
    expect(adapted[0].romanization).toBe("ni hao shi jie");
    expect(adapted[0].words.length).toBeGreaterThan(0);
  });

  it("adapts standard LRC lyric format (content & tran)", () => {
    const rawLyrics = [
      {
        content: "你 好 世界",
        time: 1000,
        endTime: 3000,
        tran: "Hello World",
      },
    ];

    const adapted = adaptClassicLines(rawLyrics, false, 5000);
    expect(adapted).toHaveLength(1);
    expect(adapted[0].text).toBe("你 好 世界");
    expect(adapted[0].translation).toBe("Hello World");
  });

  it("adapts lyric with wordTimed=false as a single unified line unit", () => {
    const yrcLyrics = [
      {
        startTime: 1000,
        endTime: 3000,
        words: [
          { word: "让", startTime: 1000, endTime: 1500 },
          { word: "旋律", startTime: 1500, endTime: 2500 },
          { word: "流淌", startTime: 2500, endTime: 3000 },
        ],
      },
    ];

    const adapted = adaptClassicLines(yrcLyrics, false, 5000);
    expect(adapted).toHaveLength(1);
    expect(adapted[0].timed).toBe(false);
    expect(adapted[0].words).toHaveLength(1);
    expect(adapted[0].words[0].text).toBe("让旋律流淌");
    expect(adapted[0].words[0].startTime).toBe(1000);
    expect(adapted[0].words[0].endTime).toBe(3000);
  });

  it("handles previewSource correctly", () => {
    const previewSource = [
      "让旋律轻轻流淌",
      "我是一句歌词",
      "让每一个字随音乐发光",
      "听见此刻的声音",
    ].map((text, index) => ({
      startTime: index * 4000,
      endTime: index * 4000 + 3500,
      words: Array.from(text).map((word, i) => ({
        word,
        startTime: index * 4000 + (i * 3500) / text.length,
        endTime: index * 4000 + ((i + 1) * 3500) / text.length,
      })),
      translatedLyric: "Let every word glow with the music",
      romanLyric: "rang xuan lü qing qing liu tang",
      isBG: false,
      isDuet: false,
    }));

    const adaptedYrc = adaptClassicLines(previewSource, true);
    expect(adaptedYrc).toHaveLength(4);
    expect(adaptedYrc[0].words.length).toBe(7);
  });

  it("keeps the upcoming line ahead during a long interlude", () => {
    const lines = adaptClassicLines([
      { content: "第一句", startTime: 1000, endTime: 2000 },
      { content: "第二句", startTime: 4000, endTime: 5000 },
      { content: "第三句", startTime: 10000, endTime: 12000 },
    ]);
    for (const time of [6500, 7000, 8000]) {
      const index = resolveActiveLineIndex(lines, time);
      expect(lines[index].isInterlude).toBe(true);
      expect(lines[index].text).toBe("......");
      expect(resolveUpcomingLine(lines, index, time)?.text).toBe("第三句");
    }
    expect(resolveUpcomingLine(lines, -1, 0)?.text).toBe("第一句");
    expect(resolveUpcomingLine(lines, lines.length - 1, 13000)).toBeNull();
  });

  it("uses the next legacy LRC timestamp when no explicit end exists", () => {
    const lines = adaptClassicLines([
      { content: "第一句", time: 1000 },
      { content: "第二句", time: 2000 },
    ]);
    expect(lines[0].endTime).toBe(2000);
  });

  it("calculates lyric seek time in exact milliseconds (never in seconds)", () => {
    // 确保返回的是毫秒数，供 player.setSeek 消费，绝不能除以 1000 导致跳转归零
    expect(lyricSeekTime(35000, 500)).toBe(34500);
    expect(lyricSeekTime(3500, 500)).toBe(3000);
    expect(lyricSeekTime(100, 200)).toBe(0);
  });
});
