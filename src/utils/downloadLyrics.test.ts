import { expect, it } from "vitest";
import { toLineDownloadLyrics } from "./downloadLyrics";

it.each([
  ["[00:01.00]<0,200>你<200,300>好", "[00:01.00]你好"],
  ["[00:01.00]<00:01.00>Hello <00:01.20>world", "[00:01.00]Hello world"],
  ["[offset:20]\n[00:01.00]你好\n[00:02.00]世界", "[offset:20]\n[00:01.00]你好\n[00:02.00]世界"],
  [
    "[00:01.00]<0,200>原文\n\n[lang:trans]\n[00:01.00]translation\n\n[lang:roma]\n[00:01.00]romaji",
    "[00:01.00]原文",
  ],
])("converts downloaded lyrics to original line LRC: %s", (input, output) => {
  expect(toLineDownloadLyrics(input)).toBe(output);
});
it("does not serialize invalid or missing lyric responses", () => {
  expect(toLineDownloadLyrics(undefined)).toBe("");
  expect(toLineDownloadLyrics({ lyric: "invalid shape" })).toBe("");
});
