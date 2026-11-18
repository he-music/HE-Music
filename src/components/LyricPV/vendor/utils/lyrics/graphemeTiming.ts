// 由 scripts/vendor-lyric-pv.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：src/utils/lyrics/graphemeTiming.ts；修改源头或导入脚本后重新生成。
import {
  splitLyricGraphemes,
  buildWordGraphemeTimings as sharedGraphemeTimings,
} from "@/components/Partita/model";
import type { Line, Word } from "../../types";

// src/utils/lyrics/graphemeTiming.ts
// Builds parser-derived grapheme timing without owning visualizer animation curves.

export interface GraphemeTiming {
  char: string;
  startTime: number;
  endTime: number;
  wordIndex?: number;
}

export { splitLyricGraphemes } from "@/components/Partita/model";
const buildEvenGraphemeTimings = (
  text: string,
  startTime: number,
  endTime: number,
  wordIndex?: number,
): GraphemeTiming[] =>
  sharedGraphemeTimings(text, startTime, endTime).map((timing) => ({
    ...timing,
    ...(wordIndex === undefined ? {} : { wordIndex }),
  }));
export const buildWordGraphemeTimings = (word: Word, wordIndex?: number): GraphemeTiming[] =>
  word.syllables?.length
    ? word.syllables.flatMap((syllable) =>
        buildEvenGraphemeTimings(syllable.text, syllable.startTime, syllable.endTime, wordIndex),
      )
    : buildEvenGraphemeTimings(word.text, word.startTime, word.endTime, wordIndex);

const findGraphemeSequence = (source: string[], target: string[], fromIndex: number): number => {
  if (target.length === 0) {
    return fromIndex;
  }

  for (let index = fromIndex; index <= source.length - target.length; index += 1) {
    let matched = true;
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      if (source[index + targetIndex] !== target[targetIndex]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return index;
    }
  }

  return -1;
};

// Maps word-level timing back to the full displayed line, including spaces and
// punctuation that may not be present in parser words.
export const buildLineGraphemeTimeline = (line: Line): GraphemeTiming[] => {
  const lineGraphemes = splitLyricGraphemes(line.fullText);
  if (lineGraphemes.length === 0) {
    return [];
  }

  if (line.words.length === 0) {
    return buildEvenGraphemeTimings(line.fullText, line.startTime, line.endTime);
  }

  const timeline: GraphemeTiming[] = [];
  let cursor = 0;
  let lastResolvedTime = line.startTime;

  line.words.forEach((word, wordIndex) => {
    const wordGraphemes = splitLyricGraphemes(word.text);
    if (wordGraphemes.length === 0) {
      return;
    }

    const matchedStart = findGraphemeSequence(lineGraphemes, wordGraphemes, cursor);
    const start = matchedStart >= 0 ? matchedStart : cursor;
    const end = Math.min(start + wordGraphemes.length, lineGraphemes.length);

    for (let gapIndex = cursor; gapIndex < start; gapIndex += 1) {
      timeline[gapIndex] = {
        char: lineGraphemes[gapIndex],
        startTime: word.startTime,
        endTime: word.startTime,
      };
    }

    const wordTimings = buildWordGraphemeTimings(word, wordIndex);
    for (let localIndex = 0; localIndex < end - start; localIndex += 1) {
      const timing =
        wordTimings[localIndex] ??
        buildEvenGraphemeTimings(
          wordGraphemes[localIndex] ?? "",
          word.startTime,
          word.endTime,
          wordIndex,
        )[0];

      if (!timing) {
        continue;
      }

      timeline[start + localIndex] = {
        ...timing,
        char: lineGraphemes[start + localIndex],
      };
      lastResolvedTime = Math.max(lastResolvedTime, timing.endTime);
    }

    cursor = Math.max(cursor, end);
  });

  for (let index = 0; index < lineGraphemes.length; index += 1) {
    if (timeline[index]) {
      continue;
    }

    timeline[index] = {
      char: lineGraphemes[index],
      startTime: lastResolvedTime,
      endTime: lastResolvedTime,
    };
  }

  return timeline;
};
