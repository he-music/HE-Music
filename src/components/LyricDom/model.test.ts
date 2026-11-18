import { describe, expect, it } from "vitest";
import { adaptPartitaLines } from "@/components/Partita/model";
import { toStageLine, stageLineIndex } from "./model";
import { createTheme } from "./vendor/types";
import { buildClassicLayout } from "./vendor/components/visualizer/classic/classicLayout";
import {
  getOrBuildPartitaLayout,
  buildPartitaWordConfigs,
  type PartitaSequentialLayout,
} from "./vendor/components/visualizer/partita/partitaLayout";
import {
  getGlowWordActiveEndTime,
  resolveGlowWordRenderProfile,
} from "./vendor/components/visualizer/glowWordTiming";
import { resolveMonetFillWidth } from "./vendor/components/visualizer/monet/monetLyricMotion";
import { fitStageContent } from "./fit";

// 防止移植边界再次把毫秒种子、字形时间或逐行歌词语义带进秒制上游算法。
const line = () =>
  toStageLine(
    adaptPartitaLines(
      [
        {
          startTime: 5137,
          endTime: 8937,
          words: Array.from("让我们的歌声穿过星空").map((word, index) => ({
            word,
            startTime: 5137 + index * 380,
            endTime: 5517 + index * 380,
          })),
        },
      ],
      true,
    ).find((line) => !line.isInterlude)!,
  );
const theme = createTheme("#e6b9a0");
describe("Folia DOM 移植边界", () => {
  it("保留逐字时间并使用秒制排版种子", () => {
    const source = line();
    expect(source.startTime).toBe(5.137);
    expect(source.words[0].syllables?.[0].startTime).toBe(5.137);
    const tuning = {
      showGuideLines: true,
      useSemanticLayout: true,
      staggerMin: 12,
      staggerMax: 36,
      avoidOverlap: true,
    };
    const first = getOrBuildPartitaLayout(new Map(), source, theme, 650, tuning);
    const again = getOrBuildPartitaLayout(new Map(), line(), theme, 650, tuning);
    expect(first).toEqual(again);
    expect(first.columns[0].words.length).toBeGreaterThan(3);
    const row = first.columns[0].words.find((chunk) => chunk.displayWords.length > 1)!;
    const words = buildPartitaWordConfigs(row.displayWords, row.config, "normal");
    expect(words[0].x).not.toBe(words[1].x);
    expect(words[0].scale).toBe(row.config.scale);
  });
  it("缓存属于宿主，歌词时间变化后不沿用另一个排版", () => {
    const cache = new Map<string, PartitaSequentialLayout>();
    const source = line();
    const tuning = {
      showGuideLines: true,
      useSemanticLayout: true,
      staggerMin: 12,
      staggerMax: 36,
      avoidOverlap: true,
    };
    const first = getOrBuildPartitaLayout(cache, source, theme, 600, tuning);
    expect(getOrBuildPartitaLayout(cache, source, theme, 600, tuning)).toBe(first);
    const later = { ...source, startTime: source.startTime + 0.1 };
    expect(getOrBuildPartitaLayout(cache, later, theme, 600, tuning)).not.toBe(first);
  });
  it("流光用实测词宽保留放大与旋转所需空间", () => {
    const source = line();
    const tuning = {
      enableWordRotation: true,
      breathingFloatMultiplier: 1,
      useLegacyLayout: false,
      wordSpacing: 0.7,
      avoidOverlap: true,
    };
    const result = buildClassicLayout(source, source.words, theme, tuning, 600, 1);
    expect(result.lineConfig.rowGap).toBeGreaterThan(0);
    expect(result.wordConfigs).toHaveLength(source.words.length);
    const still = buildClassicLayout(
      source,
      source.words,
      theme,
      { ...tuning, enableWordRotation: false },
      600,
      1,
    );
    expect(still.wordConfigs.every((word) => word.rotate === 0 && word.passedRotate === 0)).toBe(
      true,
    );
  });
  it("普通歌词不生成虚构逐字时间，短句沿用快速展示分档", () => {
    const source = toStageLine(
      adaptPartitaLines(
        [
          {
            startTime: 1000,
            endTime: 1080,
            words: [{ word: "短句", startTime: 1000, endTime: 1080 }],
          },
        ],
        false,
      )[0],
    );
    expect(source.timed).toBe(false);
    expect(source.words.every((word) => word.syllables?.length === 0)).toBe(true);
    const profile = resolveGlowWordRenderProfile(source)!;
    expect(profile.wordRevealMode).toBe("instant");
    expect(getGlowWordActiveEndTime(source.words[0], profile)).toBe(profile.lineRenderEndTime);
  });
  it("重叠歌词与回拖均按最近开唱时间选行", () => {
    const first = line();
    const second = { ...line(), key: "second", startTime: 7 };
    expect(stageLineIndex([first, second], 7.2)).toBe(1);
    expect(stageLineIndex([first, second], 6)).toBe(0);
  });
  it("莫奈扫光按实际字宽和真实字形时间前进", () => {
    const timings = [
      { char: "i", startTime: 1, endTime: 2 },
      { char: "W", startTime: 2, endTime: 3 },
    ];
    expect(resolveMonetFillWidth(1.5, 1, 3, [0, 5, 25], timings)).toBeCloseTo(2.5);
    expect(resolveMonetFillWidth(2.5, 1, 3, [0, 5, 25], timings)).toBeCloseTo(15);
    expect(resolveMonetFillWidth(3, 1, 3, [0, 5, 25], timings)).toBe(25);
  });
  it("窄歌词区域同时约束宽高，宽句不会被较大的纵向比例放回原尺寸", () => {
    expect(fitStageContent(330, 500, 600, 180)).toBeCloseTo(282 / 600);
    expect(fitStageContent(1100, 300, 600, 500)).toBeCloseTo(252 / 500);
    expect(fitStageContent(1100, 600, 600, 180)).toBe(1);
  });
});
