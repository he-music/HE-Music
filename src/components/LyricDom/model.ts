import type { PartitaLine } from "@/components/Partita/model";
import type { ClassicLine } from "@/components/Classic/types";
import type { Line, Word, Theme } from "./vendor/types";
import { createTheme } from "./vendor/types";
import { buildLineRenderHints } from "@/components/LyricPV/vendor/utils/lyrics/renderHints";
import { getLyricLanguage } from "@/utils/lyric/language";

// 只在宿主边界转换毫秒与秒，保留原始字形时间与普通歌词语义。
export interface StageLine extends Line {
  key: string;
  timed: boolean;
  isInterlude?: boolean;
}
export function toStageLine(line: PartitaLine | ClassicLine): StageLine {
  const words: Word[] = line.words.map((word) => ({
    text: word.text,
    startTime: word.startTime / 1000,
    endTime: word.endTime / 1000,
    syllables: word.graphemes.map((glyph) => ({
      text: glyph.char,
      startTime: glyph.startTime / 1000,
      endTime: glyph.endTime / 1000,
    })),
  }));
  const result: StageLine = {
    key: line.key,
    fullText: "fullText" in line ? line.fullText : line.text,
    startTime: line.startTime / 1000,
    endTime: line.endTime / 1000,
    words,
    translation: line.translation,
    romanization: line.romanization,
    timed: line.timed,
    isInterlude: line.isInterlude,
    isChorus: line.isChorus,
  };
  result.renderHints = buildLineRenderHints(result);
  return result;
}
export const cssColor = (color: string) =>
  /^(#|rgb|hsl|var\()/.test(color) ? color : `rgb(${color})`;
export function stageTheme(color: string, element: HTMLElement | null, text = ""): Theme {
  const style = element ? getComputedStyle(element) : null;
  const language = text ? getLyricLanguage(text) : "";
  const family = language ? style?.getPropertyValue(`--${language}-font-family`).trim() : "";
  const weight = language ? style?.getPropertyValue(`--${language}-font-weight`).trim() : "";
  return createTheme(
    cssColor(color),
    family || style?.fontFamily,
    Number(weight || style?.fontWeight) || 700,
  );
}
export function stageLineIndex(lines: StageLine[], time: number): number {
  // 重叠歌词与回拖均按最近开唱时间求值，不逐帧扫描整首歌词。
  let low = 0,
    high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].startTime <= time) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? low - 1 : lines.length && lines[0].startTime - time <= 1.2 ? 0 : -1;
}
