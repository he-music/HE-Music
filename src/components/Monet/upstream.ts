import type { MonetLine, MonetWord } from "./model";
import type { Line } from "@/components/LyricDom/vendor/types";
import { splitLyricGraphemes } from "@/components/Partita/model";

// 保留真实逐字时间；超长解析词按已有字形拆开，避免换行后一个遮罩点亮整块文字。
export function toMonetSource(line: MonetLine): Line {
  return {
    fullText: line.text,
    startTime: line.start / 1000,
    endTime: line.end / 1000,
    translation: line.translation,
    romanization: line.romanization,
    words: monetDisplayWords(line).map((word) => ({
      text: word.text,
      startTime: (word.glyphs[0]?.start ?? line.start) / 1000,
      endTime: (word.glyphs.at(-1)?.end ?? line.end) / 1000,
      syllables: word.glyphs.map((glyph) => ({
        text: glyph.text,
        startTime: glyph.start / 1000,
        endTime: glyph.end / 1000,
      })),
    })),
  };
}
export function monetDisplayWords(line: MonetLine): MonetWord[] {
  return line.words.flatMap((word) => {
    if (splitLyricGraphemes(word.text).length <= 12) return [word];
    return word.glyphs.map((glyph) => ({ text: glyph.text, glyphs: [glyph] }));
  });
}
