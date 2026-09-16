// src/components/Classic/model.ts
// Adapted from Folia (chthollyphile, AGPL-3.0) Visualizer.tsx & graphemeTiming.ts.

import {
  buildPostLyricLayoutUnits,
  buildDisplayWordsFromLayoutUnits,
  type PartitaWordToken,
} from "@/components/Partita/cjkSemanticLayout";
import {
  DEFAULT_CLASSIC_TUNING,
  type ClassicLine,
  type ClassicLineLayoutConfig,
  type ClassicTuning,
  type ClassicWord,
  type ClassicWordGrapheme,
  type ClassicWordLayoutConfig,
  type ClassicWordStatus,
} from "./types";

const graphemeSegmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * 将文本精准拆解为字形（支持复杂 Emoji、汉字、注音符号）
 */
export function splitLyricGraphemes(text: string): string[] {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
  }
  return Array.from(text);
}

/**
 * 构建单词内部字形的起止时间轴
 */
export function buildWordGraphemes(
  text: string,
  startTime: number,
  endTime: number,
): ClassicWordGrapheme[] {
  const chars = splitLyricGraphemes(text);
  if (chars.length === 0) return [];
  const duration = Math.max(endTime - startTime, 0);
  const step = duration / chars.length;

  return chars.map((char, index) => ({
    char,
    startTime: Math.round(startTime + step * index),
    endTime: index === chars.length - 1 ? endTime : Math.round(startTime + step * (index + 1)),
  }));
}

/**
 * 确定性随机数生成器（基于给定 seed）
 */
export function deterministicRandom(seed: number, offset: number): number {
  const x = Math.sin(seed + offset) * 10000;
  return x - Math.floor(x);
}

/**
 * 为当前活跃行生成确定性的单词排版几何与旋转参数
 */
export function resolveDeterministicWordLayouts(
  line: ClassicLine,
  tuning: Partial<ClassicTuning> = {},
): {
  wordConfigs: ClassicWordLayoutConfig[];
  lineConfig: ClassicLineLayoutConfig;
} {
  const resolvedTuning: ClassicTuning = { ...DEFAULT_CLASSIC_TUNING, ...tuning };
  const seed = line.startTime;

  // 容器对齐确定性轻微随机（保持自然现代海报风）
  const justifyOptions: ClassicLineLayoutConfig["justifyContent"][] = [
    "center",
    "center",
    "flex-start",
    "flex-end",
    "space-around",
  ];
  const alignOptions: ClassicLineLayoutConfig["alignItems"][] = [
    "center",
    "center",
    "flex-start",
    "flex-end",
  ];

  const lineConfig: ClassicLineLayoutConfig = {
    justifyContent: justifyOptions[Math.floor(Math.abs(seed) % justifyOptions.length)],
    alignItems: alignOptions[Math.floor(Math.abs(seed * 2) % alignOptions.length)],
    perspective: 1000,
  };

  const baseSpread = 16; // 词级错落散布范围 (px)
  const baseRotate = resolvedTuning.enableWordRotation ? 6 : 0; // 最大倾斜角度 (度)

  const wordConfigs: ClassicWordLayoutConfig[] = line.words.map((w, i) => {
    const wordSeed = seed + i * 37;
    const xVal = (deterministicRandom(wordSeed, 1) - 0.5) * baseSpread * 2;
    const yVal = (deterministicRandom(wordSeed, 2) - 0.5) * baseSpread * 2;
    const wordScale = 1.05 + deterministicRandom(wordSeed, 4) * 0.15;
    const rotate = resolvedTuning.enableWordRotation
      ? (deterministicRandom(wordSeed, 3) - 0.5) * baseRotate * 2
      : 0;
    const passedRotate = resolvedTuning.enableWordRotation
      ? (deterministicRandom(wordSeed, 8) - 0.5) * 36
      : 0;

    // 根据前后词估算安全 marginRight，防止放大重叠
    const spacingMultiplier = resolvedTuning.wordSpacing ?? 0.7;
    const marginPx = Math.max(8, (12 + Math.abs(xVal)) * spacingMultiplier);

    return {
      id: `${w.text}-${i}-${seed}`,
      x: Math.round(xVal * 10) / 10,
      y: Math.round(yVal * 10) / 10,
      rotate: Math.round(rotate * 10) / 10,
      scale: Math.round(wordScale * 100) / 100,
      marginRight: `${marginPx.toFixed(1)}px`,
      passedRotate: Math.round(passedRotate * 10) / 10,
    };
  });

  return { wordConfigs, lineConfig };
}

/**
 * 解析单个词在当前时钟下的状态
 */
export function resolveWordStatus(
  word: ClassicWord,
  currentTime: number,
  lookahead = 120,
): ClassicWordStatus {
  if (currentTime >= word.startTime - lookahead && currentTime <= word.endTime) {
    return "active";
  }
  if (currentTime > word.endTime) {
    return "passed";
  }
  return "waiting";
}

/**
 * 查找当前时间对应的活跃行索引
 * 契合 Folia 原版 runtime 机制：前奏展示第 0 句，间奏过渡预热下一句，曲终保留末句
 */
export function resolveActiveLineIndex(lines: ClassicLine[], currentTime: number): number {
  if (!lines.length) return -1;

  // 1. 查找是否有正在演唱的行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (currentTime >= line.startTime && currentTime < line.endTime) {
      return i;
    }
  }

  // 2. 前奏阶段（时间未到第一句）：直接展示第一句（waiting 态静候）
  if (currentTime < lines[0].startTime) {
    return 0;
  }

  // 3. 间奏或曲终：从后往前找已播放完毕的最近行
  for (let i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].endTime) {
      // 若距离下一句很近（<= 1500ms），预热下一句
      if (i + 1 < lines.length && lines[i + 1].startTime - currentTime <= 1500) {
        return i + 1;
      }
      return i;
    }
  }

  return 0;
}

/**
 * 将 HE-Music 原始歌词数据转换为 Classic 标准模型
 * 兼容 AMLL (LyricLine: words[].word, translatedLyric) 和标准网易云/QQ 歌词
 */
export function adaptClassicLines(
  rawLyrics: any[],
  wordTimed = false,
  totalDurationMs?: number,
): ClassicLine[] {
  if (!Array.isArray(rawLyrics) || !rawLyrics.length) return [];

  // 过滤并按起始时间排序
  const sorted = rawLyrics
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      if (!line) return false;
      if (Array.isArray(line.words) && line.words.length) {
        return line.words.some((w: any) => Boolean((w.word ?? w.text ?? w.content ?? "").trim()));
      }
      return Boolean((line.content ?? line.text ?? "").trim());
    })
    .sort(
      (a, b) =>
        (a.line.startTime ?? a.line.time ?? 0) - (b.line.startTime ?? b.line.time ?? 0),
    );

  if (!sorted.length) return [];

  return sorted
    .map(({ line, index }, position) => {
      const start = Math.max(0, line.startTime ?? line.time ?? 0);
      const nextStart = sorted
        .slice(position + 1)
        .find((item) => (item.line.startTime ?? item.line.time ?? 0) > start)?.line.startTime;

      // 计算行结束时间
      const rawWords = Array.isArray(line.words) ? line.words : [];
      const wordEnd = rawWords.length
        ? Math.max(
            start,
            ...rawWords.map((w: any) =>
              Number(w.endTime ?? (w.startTime ?? w.time ?? start) + (w.duration ?? 200)),
            ),
          )
        : start;

      const explicitEnd = Math.max(Number(line.endTime ?? 0), wordTimed ? wordEnd : start);
      const end =
        explicitEnd > start
          ? explicitEnd
          : Math.max(
              start + 1,
              nextStart ??
                (totalDurationMs && totalDurationMs > start ? totalDurationMs : start + 4000),
            );

      const timed =
        wordTimed &&
        rawWords.some(
          (w: any) =>
            Number(w.endTime ?? (w.startTime ?? w.time ?? 0) + (w.duration ?? 0)) >
            Number(w.startTime ?? w.time ?? 0),
        );

      let words: ClassicWord[] = [];
      let fullText = "";

      if (!wordTimed) {
        // 关闭逐字模式：整行作为一个整体单元，不进行内部切词和字级时间差
        if (rawWords.length > 0) {
          fullText = rawWords
            .map((w: any) => String(w.word ?? w.text ?? w.content ?? ""))
            .join("");
        } else {
          fullText = String(line.content ?? line.text ?? "").trim();
        }
        if (fullText) {
          words = [
            {
              text: fullText,
              startTime: start,
              endTime: end,
              graphemes: buildWordGraphemes(fullText, start, end),
            },
          ];
        }
      } else if (rawWords.length > 0) {
        // AMLL 或 YRC 逐字数据
        const tokens: PartitaWordToken[] = rawWords
          .map((w: any) => {
            const text = String(w.word ?? w.text ?? w.content ?? "");
            const wStart = Number(w.startTime ?? w.time ?? start);
            const wEnd = Number(w.endTime ?? wStart + (w.duration ?? 200));
            return { text, startTime: wStart, endTime: wEnd };
          })
          .filter((t) => t.text.length > 0);

        fullText = tokens.map((t) => t.text).join("");

        // 应用 CJK 语义分词与标点粘滞
        const layoutUnits = buildPostLyricLayoutUnits(fullText, tokens, {
          semantic: true,
          sticky: true,
        });
        const displayTokens = buildDisplayWordsFromLayoutUnits(layoutUnits);

        words = displayTokens.map((token) => ({
          text: token.text,
          startTime: token.startTime,
          endTime: token.endTime,
          graphemes: buildWordGraphemes(token.text, token.startTime, token.endTime),
        }));
      } else {
        // 普通 LRC 文本
        fullText = String(line.content ?? line.text ?? "").trim();
        if (fullText) {
          const tokens = fullText.split(/(\s+)/).filter((s: string) => s.length > 0);
          const lineDuration = Math.max(end - start, 500);
          const step = lineDuration / Math.max(tokens.length, 1);
          words = tokens.map((token: string, ti: number) => {
            const wStart = Math.round(start + step * ti);
            const wEnd =
              ti === tokens.length - 1 ? end : Math.round(start + step * (ti + 1));
            return {
              text: token,
              startTime: wStart,
              endTime: wEnd,
              graphemes: buildWordGraphemes(token, wStart, wEnd),
            };
          });
        }
      }

      const translation = (
        line.translatedLyric ??
        line.translation ??
        line.tran ??
        ""
      ).trim() || undefined;
      const romanization = (
        line.romanLyric ??
        line.romanization ??
        line.roma ??
        ""
      ).trim() || undefined;
      const key = `${index}:${start}`;

      return {
        key,
        text: fullText,
        translation,
        romanization,
        startTime: start,
        endTime: end,
        words,
        timed: timed && words.length > 0,
        isChorus: Boolean(
          line.isChorus || fullText.includes("♪") || fullText.includes(" Chorus "),
        ),
      };
    })
    .filter((line) => line.text.length > 0);
}

/**
 * 换算跳转目标毫秒数（供 player.setSeek 消费，单位毫秒）
 */
export function lyricSeekTime(ms: number, songOffset = 0): number {
  return Math.max(0, ms - songOffset);
}
