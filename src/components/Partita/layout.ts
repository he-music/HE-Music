// Adapted from Folia (chthollyphile), AGPL-3.0: VisualizerPartita / layout.
// https://github.com/chthollyphile/folia-major

import type { PartitaLine, PartitaWord } from "./model";
import {
  buildPostLyricLayoutUnits,
  buildDisplayWordsFromLayoutUnits,
  type LyricLayoutUnit,
  type PartitaWordToken,
} from "./cjkSemanticLayout";

export interface PartitaWordLayoutConfig {
  id: string;
  x: number;
  y: number;
  rotate: number;
  scale: number;
  marginBottom: string;
  passedRotate: number;
}

export interface PartitaChunkData {
  id: string;
  rowIndex: number;
  chunkUnits: LyricLayoutUnit[];
  chunkWords: PartitaWord[];
  displayWords: PartitaWordToken[];
  guidePosition: "left" | "right";
  config: PartitaWordLayoutConfig;
}

export interface PartitaSequentialLayout {
  chunks: PartitaChunkData[];
  totalGraphemes: number;
}

export interface PartitaTuningOptions {
  showGuideLines?: boolean;
  useSemanticLayout?: boolean;
  staggerMin?: number; // 阶梯最小位移 (px)
  staggerMax?: number; // 阶梯最大位移 (px)
}

export const DEFAULT_PARTITA_TUNING: Required<PartitaTuningOptions> = {
  showGuideLines: true,
  useSemanticLayout: true,
  staggerMin: 12,
  staggerMax: 36,
};

const LAYOUT_CACHE_LIMIT = 48;
const layoutCache = new Map<string, PartitaSequentialLayout>();

export const buildPartitaLayoutCacheKey = (
  line: PartitaLine,
  containerHeight: number,
  tuning: Required<PartitaTuningOptions>,
): string => {
  const heightBucket = Math.round(containerHeight / 24);
  return JSON.stringify([
    line.key,
    line.startTime,
    line.endTime,
    line.words.map((word) => [word.text, word.startTime, word.endTime]),
    line.fullText,
    line.isInterlude ?? false,
    heightBucket,
    tuning.staggerMin,
    tuning.staggerMax,
    tuning.showGuideLines,
    tuning.useSemanticLayout,
  ]);
};

/** 计算一整行歌词的分块阶梯布局（确定性算法，根据 startTime 生成稳定排版） */
export const buildSequentialChunks = (
  line: PartitaLine,
  containerHeight: number,
  tuning: Required<PartitaTuningOptions> = DEFAULT_PARTITA_TUNING,
): PartitaSequentialLayout => {
  if (line.isInterlude) {
    return {
      totalGraphemes: 6,
      chunks: [
        {
          id: line.key,
          rowIndex: 0,
          chunkUnits: [],
          chunkWords: line.words,
          displayWords: line.words,
          guidePosition: "left",
          config: {
            id: line.key,
            x: 0,
            y: 0,
            rotate: 0,
            scale: 1,
            marginBottom: "0px",
            passedRotate: 0,
          },
        },
      ],
    };
  }
  const totalGraphemes = Math.max(line.fullText.replace(/\s+/g, "").length, line.words.length, 1);

  // 1. CJK 语义分词与标点粘滞
  const layoutUnits = buildPostLyricLayoutUnits(line.fullText, line.words, {
    semantic: tuning.useSemanticLayout,
    sticky: true,
  });

  if (layoutUnits.length === 0) {
    return { chunks: [], totalGraphemes: 0 };
  }

  // 2. 根据容器高度与单元总数确定理想行数（1~3 行）
  const baseRowHeight = 90;
  const availableHeight = containerHeight > 0 ? containerHeight * 0.6 : 360;
  const targetRowCount = Math.max(1, Math.min(3, Math.floor(availableHeight / baseRowHeight)));
  const actualRowCount = Math.min(layoutUnits.length, targetRowCount);

  let seed = line.startTime;
  const random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  // 3. 动态且富有自然节奏的分块切分
  const chunksUnits: LyricLayoutUnit[][] = [];
  let remainingUnits = layoutUnits.length;
  let remainingChunks = actualRowCount;
  let unitIndex = 0;

  for (let c = 0; c < actualRowCount; c++) {
    const isLastChunk = c === actualRowCount - 1;
    const avg = remainingUnits / remainingChunks;

    let chunkLength = 1;
    if (isLastChunk) {
      chunkLength = remainingUnits;
    } else {
      const max = Math.ceil(avg * 1.5);
      const min = 1;
      const randVal = random();
      chunkLength = Math.max(min, Math.min(max, Math.round(avg + (randVal - 0.5) * avg)));
    }

    chunkLength = Math.max(1, Math.min(chunkLength, remainingUnits - (remainingChunks - 1)));
    chunksUnits.push(layoutUnits.slice(unitIndex, unitIndex + chunkLength));
    unitIndex += chunkLength;
    remainingUnits -= chunkLength;
    remainingChunks--;
  }

  // 4. 为每个 chunk 构建位移、标尺引导线和配置
  const chunks: PartitaChunkData[] = [];

  chunksUnits.forEach((chunkUnits, rowIndex) => {
    // 提取属于该 chunk 的词与显示词
    const chunkWords = chunkUnits.flatMap((u) => u.words) as PartitaWord[];
    const displayWords = buildDisplayWordsFromLayoutUnits(chunkUnits);
    if (chunkWords.length === 0) return;

    const isStaggeredLeft = rowIndex % 2 === 0;
    const staggerMagnitude =
      tuning.staggerMin + random() * Math.max(tuning.staggerMax - tuning.staggerMin, 0);
    const staggerX = isStaggeredLeft ? -staggerMagnitude : staggerMagnitude;
    const guidePosition = isStaggeredLeft ? "left" : "right";

    const config: PartitaWordLayoutConfig = {
      id: `${line.key}-chunk-${rowIndex}`,
      x: staggerX,
      y: 0,
      rotate: isStaggeredLeft ? -1.5 : 1.5,
      scale: 1,
      marginBottom: "0.8rem",
      passedRotate: (rowIndex % 2 === 0 ? 1 : -1) * 2,
    };

    chunks.push({
      id: `${line.key}-c${rowIndex}`,
      rowIndex,
      chunkUnits,
      chunkWords,
      displayWords,
      guidePosition,
      config,
    });
  });

  return {
    chunks,
    totalGraphemes,
  };
};

/** 带 LRU 缓存的排版获取函数 */
export const getOrBuildPartitaLayout = (
  line: PartitaLine,
  containerHeight: number,
  tuning: Required<PartitaTuningOptions> = DEFAULT_PARTITA_TUNING,
): PartitaSequentialLayout => {
  const cacheKey = buildPartitaLayoutCacheKey(line, containerHeight, tuning);
  const cached = layoutCache.get(cacheKey);
  if (cached) {
    layoutCache.delete(cacheKey);
    layoutCache.set(cacheKey, cached);
    return cached;
  }

  const layout = buildSequentialChunks(line, containerHeight, tuning);
  layoutCache.set(cacheKey, layout);

  if (layoutCache.size > LAYOUT_CACHE_LIMIT) {
    const oldestKey = layoutCache.keys().next().value;
    if (oldestKey) layoutCache.delete(oldestKey);
  }

  return layout;
};
