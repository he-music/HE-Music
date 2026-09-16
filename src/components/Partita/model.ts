// Adapted from Folia (chthollyphile), AGPL-3.0: VisualizerPartita / graphemeTiming.
// https://github.com/chthollyphile/folia-major

import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import type { PartitaWordToken } from "./cjkSemanticLayout";

export interface PartitaGraphemeTiming {
  char: string;
  startTime: number;
  endTime: number;
}

export interface PartitaWord extends PartitaWordToken {
  graphemes: PartitaGraphemeTiming[];
}

export interface PartitaLine {
  key: string;
  fullText: string;
  startTime: number; // 毫秒
  endTime: number; // 毫秒
  words: PartitaWord[];
  timed: boolean;
  translation: string;
  romanization: string;
  background: boolean;
  duet: boolean;
  isChorus?: boolean;
}

export type WordPlayStatus = "waiting" | "active" | "passed";
export type LinePlayStatus = "waiting" | "active" | "passed";

const graphemeSegmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export const splitLyricGraphemes = (text: string): string[] => {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
  }
  return Array.from(text);
};

export const buildWordGraphemeTimings = (
  text: string,
  startTime: number,
  endTime: number,
): PartitaGraphemeTiming[] => {
  const chars = splitLyricGraphemes(text);
  if (chars.length === 0) return [];
  const duration = Math.max(endTime - startTime, 0);
  const unitDuration = duration / chars.length;

  return chars.map((char, index) => ({
    char,
    startTime: startTime + unitDuration * index,
    endTime: index === chars.length - 1 ? endTime : startTime + unitDuration * (index + 1),
  }));
};

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** 将 AMLL 格式歌词转换为 Partita 行数据模型（时间统一为毫秒） */
export function adaptPartitaLines(
  input: LyricLine[],
  wordTimed: boolean,
  duration = 0,
): PartitaLine[] {
  const sorted = input
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.words?.some((word) => word.word?.trim()))
    .sort((a, b) => a.line.startTime - b.line.startTime);

  return sorted.map(({ line, index }, position) => {
    const start = Math.max(0, finite(line.startTime, 0));
    const nextStart = sorted.slice(position + 1).find((item) => item.line.startTime > start)
      ?.line.startTime;

    const wordEnd = Math.max(start, ...line.words.map((w) => finite(w.endTime, start)));
    const explicitEnd = Math.max(finite(line.endTime, start), wordTimed ? wordEnd : start);
    const end =
      explicitEnd > start
        ? explicitEnd
        : Math.max(start + 1, nextStart ?? (duration > start ? duration : start + 5000));

    const timed = wordTimed && line.words.some((w) => w.endTime > w.startTime);

    const words: PartitaWord[] = line.words.map((w) => {
      const text = w.word || "";
      const wordStart = finite(w.startTime, start);
      const wordFinish = Math.max(wordStart, finite(w.endTime, wordStart));
      return {
        text,
        startTime: wordStart,
        endTime: wordFinish,
        graphemes: buildWordGraphemeTimings(text, wordStart, wordFinish),
      };
    });

    const fullText = words.map((w) => w.text).join("");

    return {
      key: `${index}:${start}`,
      fullText,
      startTime: start,
      endTime: end,
      words,
      timed,
      translation: line.translatedLyric || "",
      romanization: line.romanLyric || "",
      background: Boolean(line.isBG),
      duet: Boolean(line.isDuet),
      isChorus: false, // 可后续结合副歌检测标注
    };
  });
}

/** 计算跳转时间，考虑用户偏移量 */
export function lyricSeekTime(targetTime: number, offset = 0): number {
  return Math.max(0, targetTime - offset);
}

/** 查找当前时间所处的行索引与前后关系 */
export function resolvePartitaFrame(lines: PartitaLine[], time: number) {
  let activeIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (time >= line.startTime && time < line.endTime) {
      activeIndex = i;
      break;
    }
  }

  // 若处于两句之间的空白期，寻找最近前一句或下一句
  if (activeIndex === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (time >= lines[i].endTime) {
        // 当前在某句播放完毕之后
        if (i + 1 < lines.length && time < lines[i + 1].startTime) {
          // 在间奏中：如果距离下一句较近（<= 1200ms），预热下一句
          if (lines[i + 1].startTime - time <= 1200) {
            activeIndex = i + 1;
          } else {
            activeIndex = i; // 保持停留在刚才放完的行
          }
        } else if (i === lines.length - 1) {
          activeIndex = i; // 最后一句结束后保留
        }
        break;
      }
    }
  }

  // 刚开播前若未开始
  if (activeIndex === -1 && lines.length > 0 && time < lines[0].startTime) {
    activeIndex = 0;
  }

  return {
    activeIndex,
    activeLine: activeIndex >= 0 ? lines[activeIndex] : null,
    upcomingLine:
      activeIndex >= 0 && activeIndex + 1 < lines.length ? lines[activeIndex + 1] : null,
  };
}
