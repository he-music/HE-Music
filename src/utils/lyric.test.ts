import { expect, it } from "vitest";
import { parseSongLyric } from "./lyric";

it.each([
  { lyric: "[00:01.2]<0,500>原文", type: "yrcData" },
  { lyric: "[00:01.2]原文", type: "lrcData" },
] as const)("$type 按实际时间同时对齐译文和罗马音，不串到下一句", ({ lyric, type }) => {
  const lines = parseSongLyric({
    lyric: lyric + "\n[00:02]第二句",
    trans: "[00:01.20]译文\n[00:02.100]不匹配的译文",
    roma: "[00:01.200]Romanization\n[00:02.000]Second",
  })[type];
  expect(lines).toMatchObject([
    { startTime: 1200, translatedLyric: "译文", romanLyric: "Romanization" },
    { startTime: 2000, translatedLyric: "", romanLyric: "Second" },
  ]);
});

it("独立字段优先，缺少的字段从正文附带的语言轨读取", () => {
  const { yrcData } = parseSongLyric({
    lyric: "[00:01]<0,500>原文\n[lang:trans]\n[00:01.00]内嵌译文\n[lang:roma]\n[00:01.000]Roma",
    trans: "[00:01.00]独立译文",
    roma: " ",
  });
  expect(yrcData).toHaveLength(1);
  expect(yrcData[0]).toMatchObject({ translatedLyric: "独立译文", romanLyric: "Roma" });
});
