// src/components/Classic/model.ts
// Adapted from Folia (chthollyphile, AGPL-3.0) Visualizer.tsx & graphemeTiming.ts.

import { insertInterludes } from "../LyricStage/interludes";
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
  options?: { containerWidth?: number },
): {
  wordConfigs: ClassicWordLayoutConfig[];
  lineConfig: ClassicLineLayoutConfig;
} {
  const resolvedTuning: ClassicTuning = { ...DEFAULT_CLASSIC_TUNING, ...tuning };
  const seed = line.startTime;
  const containerW = options?.containerWidth ?? 1000;
  const widthFactor = Math.max(0.5, Math.min(1.0, containerW / 760));

  // 整句始终居中，视觉错落只由下方的词级位移与旋转承担。
  const lineConfig: ClassicLineLayoutConfig = {
    justifyContent: "center",
    alignItems: "center",
    perspective: 1000,
  };

  // 错落散布与旋转：移动设备上按比例收拢，防止字词位移过大飞出边界
  const baseSpread = Math.round(16 * widthFactor); // 词级错落散布范围 (px)
  const baseRotate = resolvedTuning.enableWordRotation
    ? Math.max(2, Math.round(6 * widthFactor))
    : 0; // 最大倾斜角度 (度)

  const wordConfigs: ClassicWordLayoutConfig[] = line.words.map((w, i) => {
    const wordSeed = seed + i * 37;
    if (line.isInterlude) {
      return {
        id: `${w.text}-${i}-${seed}`,
        x: 0,
        y: (deterministicRandom(wordSeed, 2) - 0.5) * 15 * widthFactor,
        rotate: 0,
        scale: 1.5,
        marginRight: i === line.words.length - 1 ? "0px" : `${48 * widthFactor}px`,
        passedRotate: 0,
      };
    }
    const xVal = (deterministicRandom(wordSeed, 1) - 0.5) * baseSpread * 2;
    const yVal = (deterministicRandom(wordSeed, 2) - 0.5) * baseSpread * 2;
    const wordScale = 1.05 + deterministicRandom(wordSeed, 4) * 0.15;
    const rotate = resolvedTuning.enableWordRotation
      ? (deterministicRandom(wordSeed, 3) - 0.5) * baseRotate * 2
      : 0;
    const passedRotate = resolvedTuning.enableWordRotation
      ? (deterministicRandom(wordSeed, 8) - 0.5) * 36 * widthFactor
      : 0;

    // 根据前后词估算安全 marginRight，移动端按比例缩减，防止放大重叠与右侧溢出
    const spacingMultiplier = (resolvedTuning.wordSpacing ?? 0.7) * widthFactor;
    const marginPx = Math.max(4, (12 + Math.abs(xVal)) * spacingMultiplier);

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

  // 与 Folia 一致：重叠时优先显示最近开始的行，不等待上一句尾音结束。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (currentTime >= line.startTime && currentTime < line.endTime) {
      return i;
    }
  }

  // 2. 前奏阶段（时间未到第一句）：
  // 若距离第一句很近（<= 1200ms），预热第一句准备开唱；否则返回 -1 展示等待态
  if (currentTime < lines[0].startTime) {
    if (lines[0].startTime - currentTime <= 1200) {
      return 0;
    }
    return -1;
  }

  // 3. 间奏或曲终：从后往前找已播放完毕的最近行
  for (let i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].endTime) {
      // 若距离下一句很近（<= 1500ms），预热下一句准备开唱
      if (i + 1 < lines.length && lines[i + 1].startTime - currentTime <= 1500) {
        return i + 1;
      }
      // 若刚唱完不久（<= 1200ms），保持当前行供回味
      if (currentTime - lines[i].endTime <= 1200) {
        return i;
      }
      // 间奏较长时返回 -1 展示等待态
      if (i + 1 < lines.length) {
        return -1;
      }
      return i;
    }
  }

  return 0;
}

/** 前奏与间奏都按时间寻找下一句，避免等待态跳回第一句。 */
export function resolveUpcomingLine(
  lines: ClassicLine[],
  activeIndex: number,
  currentTime: number,
): ClassicLine | null {
  const upcoming =
    activeIndex >= 0
      ? lines.slice(activeIndex + 1)
      : lines.filter((line) => line.startTime > currentTime);
  return upcoming.find((line) => !line.isInterlude) ?? null;
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
      (a, b) => (a.line.startTime ?? a.line.time ?? 0) - (b.line.startTime ?? b.line.time ?? 0),
    );

  if (!sorted.length) return [];

  const adapted: ClassicLine[] = sorted
    .map(({ line, index }, position) => {
      const start = Math.max(0, line.startTime ?? line.time ?? 0);
      const nextLine = sorted
        .slice(position + 1)
        .find((item) => (item.line.startTime ?? item.line.time ?? 0) > start)?.line;
      const nextStart = nextLine?.startTime ?? nextLine?.time;

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

      if (rawWords.length > 0 && timed) {
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
        // 普通歌词或非逐字模式：根据 fullText 智能按语义/空格切词，杜绝整句合并导致的不可换行与溢出
        if (rawWords.length > 0) {
          fullText = rawWords.map((w: any) => String(w.word ?? w.text ?? w.content ?? "")).join("");
        } else {
          fullText = String(line.content ?? line.text ?? "").trim();
        }

        if (fullText) {
          let rawSegments: string[] = [];
          if (typeof Intl !== "undefined" && Intl.Segmenter) {
            try {
              const seg = new Intl.Segmenter(undefined, { granularity: "word" });
              rawSegments = Array.from(seg.segment(fullText), (p) => p.segment);
            } catch {
              rawSegments = fullText.split(/(\s+)/);
            }
          } else {
            rawSegments = fullText.split(/(\s+)/);
          }

          // 合并过碎的助词标点，单个词组尽量在 2~6 个字符以内
          const mergedTokens: string[] = [];
          let currentChunk = "";
          for (const s of rawSegments) {
            if (!s) continue;
            if (currentChunk.length > 0 && currentChunk.length + s.length > 6 && !/^\s+$/.test(s)) {
              mergedTokens.push(currentChunk);
              currentChunk = s;
            } else {
              currentChunk += s;
            }
          }
          if (currentChunk) mergedTokens.push(currentChunk);

          const finalTokens = mergedTokens.filter((s) => s.trim().length > 0);
          const tokensList = finalTokens.length > 0 ? finalTokens : [fullText];

          // 分词只服务排版；没有逐字时间时所有词共享整行时间。
          words = tokensList.map((token: string) => ({
            text: token,
            startTime: start,
            endTime: end,
            graphemes: [],
          }));
        }
      }

      const translation =
        (line.translatedLyric ?? line.translation ?? line.tran ?? "").trim() || undefined;
      const romanization =
        (line.romanLyric ?? line.romanization ?? line.roma ?? "").trim() || undefined;
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
        isChorus: Boolean(line.isChorus || fullText.includes("♪") || fullText.includes(" Chorus ")),
      };
    })
    .filter((line) => line.text.length > 0);
  return insertInterludes<ClassicLine>(
    adapted,
    (line) => line,
    (line) => line,
  );
}

/**
 * 换算跳转目标毫秒数（供 player.setSeek 消费，单位毫秒）
 */
export function lyricSeekTime(ms: number, songOffset = 0): number {
  return Math.max(0, ms - songOffset);
}
