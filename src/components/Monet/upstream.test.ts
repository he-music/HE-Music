import { expect, it } from "vitest";
import { adaptMonetLines } from "./model";
import { monetDisplayWords, toMonetSource } from "./upstream";

// 超长解析词拆成可换行的展示单元，但每个字仍使用真实来源的时间。
it("超长词换行不改变字形时间或丢掉空白", () => {
  const text = "这是一句 足够长的歌词用来检查换行后的逐字时间";
  const line = adaptMonetLines(
    [
      {
        startTime: 1000,
        endTime: 6000,
        words: [{ word: text, startTime: 1000, endTime: 6000 }],
        translatedLyric: "translation",
        romanLyric: "romanization",
        isBG: false,
        isDuet: false,
      },
    ],
    true,
  )[0];
  const displayed = monetDisplayWords(line);
  expect(displayed.map((word) => word.text).join("")).toBe(text);
  expect(displayed.flatMap((word) => word.glyphs)).toEqual(line.words[0].glyphs);
  const source = toMonetSource(line);
  expect(source.words[0].startTime).toBe(1);
  expect(source.words.at(-1)?.endTime).toBe(6);
  expect(
    source.words
      .flatMap((word) => word.syllables)
      .map((glyph) => glyph?.text)
      .join(""),
  ).toBe(text);
});
it("多个字形的普通词保留为连续扫光单元", () => {
  const line = adaptMonetLines(
    [
      {
        startTime: 1000,
        endTime: 3000,
        words: [{ word: "singing", startTime: 1000, endTime: 3000 }],
        translatedLyric: "",
        romanLyric: "",
        isBG: false,
        isDuet: false,
      },
    ],
    true,
  )[0];
  expect(monetDisplayWords(line)).toHaveLength(1);
  expect(toMonetSource(line).words[0].syllables).toHaveLength(7);
});
