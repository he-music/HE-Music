import type { LyricLine } from "@applemusic-like-lyrics/lyric";

// src/components/Monet/model.ts — AMLL 毫秒时间轴到 Monet 歌词轨道的适配。
export interface MonetGlyph {
  text: string;
  start: number;
  end: number;
}
export interface MonetWord {
  text: string;
  glyphs: MonetGlyph[];
}
export interface MonetLine {
  key: string;
  text: string;
  start: number;
  end: number;
  words: MonetWord[];
  timed: boolean;
  translation: string;
  romanization: string;
  background: boolean;
  duet: boolean;
}
export type LineStatus = "active" | "waiting" | "passed";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** 保留空白、和声和对唱；只将真实逐字时间拆到字形，普通 LRC 不生成扫光时间。 */
export function adaptMonetLines(input: LyricLine[], wordTimed: boolean, duration = 0): MonetLine[] {
  const sorted = input
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.words?.some((word) => word.word?.trim()))
    .sort((a, b) => a.line.startTime - b.line.startTime);
  return sorted.map(({ line, index }, position) => {
    const start = Math.max(0, finite(line.startTime, 0));
    const nextStart = sorted.slice(position + 1).find((item) => item.line.startTime > start)
      ?.line.startTime;
    const wordEnd = Math.max(start, ...line.words.map((word) => finite(word.endTime, start)));
    const explicitEnd = Math.max(finite(line.endTime, start), wordTimed ? wordEnd : start);
    const end =
      explicitEnd > start
        ? explicitEnd
        : Math.max(start + 1, nextStart ?? (duration > start ? duration : start + 5000));
    const timed = wordTimed && line.words.some((word) => word.endTime > word.startTime);
    const words = line.words.map((word) => {
      const text = word.word || "";
      const glyphs = Array.from(segmenter.segment(text), (part) => part.segment);
      const wordStart = finite(word.startTime, start);
      const wordFinish = Math.max(wordStart, finite(word.endTime, wordStart));
      return {
        text,
        glyphs: glyphs.map((text, i) => ({
          text,
          start: wordStart + ((wordFinish - wordStart) * i) / glyphs.length,
          end: wordStart + ((wordFinish - wordStart) * (i + 1)) / glyphs.length,
        })),
      };
    });
    return {
      key: `${index}:${start}`,
      text: words.map((word) => word.text).join(""),
      start,
      end,
      words,
      timed,
      translation: line.translatedLyric || "",
      romanization: line.romanLyric || "",
      background: Boolean(line.isBG),
      duet: Boolean(line.isDuet),
    };
  });
}

export function lineStatus(line: MonetLine, time: number): LineStatus {
  return time < line.start ? "waiting" : time >= line.end ? "passed" : "active";
}

/** 和声可同时高亮，但滚动优先跟随主唱；间奏锚定下一句，结束后保留最后一句。 */
export function resolveMonetFrame(lines: MonetLine[], time: number) {
  let active = -1;
  let background = -1;
  let upcoming = -1;
  const statuses = lines.map((line, index) => {
    const status = lineStatus(line, time);
    if (status === "active") {
      if (line.background) background = index;
      else active = index;
    } else if (status === "waiting" && upcoming === -1) upcoming = index;
    return status;
  });
  const anchor =
    active >= 0
      ? active
      : background >= 0
        ? background
        : upcoming >= 0
          ? upcoming
          : lines.length - 1;
  return { anchor, statuses };
}

export function lyricSeekTime(start: number, offset: number) {
  return Math.max(0, start - offset);
}
