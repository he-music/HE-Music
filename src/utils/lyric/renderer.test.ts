import { describe, expect, it } from "vitest";
import { deserializeLyricSettings } from "./renderer";

// src/utils/lyric/renderer.test.ts — 保护旧设置迁移和未来效果选择入口。
describe("lyric renderer persistence", () => {
  it.each([
    [true, "amll"],
    [false, "default"],
    [undefined, "default"],
  ])("migrates legacy %s", (useAMLyrics, renderer) => {
    const result = deserializeLyricSettings(JSON.stringify({ useAMLyrics, lyricFontSize: 38 }));
    expect(result).toEqual({ lyricRenderer: renderer, lyricFontSize: 38 });
  });
  it("keeps an explicit new choice when an old flag remains", () => {
    expect(deserializeLyricSettings('{"lyricRenderer":"monet","useAMLyrics":true}')).toEqual({
      lyricRenderer: "monet",
    });
    expect(deserializeLyricSettings('{"lyricRenderer":"partita","useAMLyrics":true}')).toEqual({
      lyricRenderer: "partita",
    });
    expect(deserializeLyricSettings('{"lyricRenderer":"classic","useAMLyrics":true}')).toEqual({
      lyricRenderer: "classic",
    });
    expect(deserializeLyricSettings('{"lyricRenderer":"default","useAMLyrics":true}')).toEqual({
      lyricRenderer: "default",
    });
  });
  it("persists kinetic lyrics across restarts", () => {
    expect(deserializeLyricSettings('{"lyricRenderer":"kinetic","useAMLyrics":true}')).toEqual({
      lyricRenderer: "kinetic",
    });
  });
  it.each(["auto", "character", "word"])("persists kinetic jump mode %s", (mode) => {
    expect(
      deserializeLyricSettings(
        JSON.stringify({ lyricRenderer: "kinetic", kineticJumpGranularity: mode }),
      ),
    ).toMatchObject({ kineticJumpGranularity: mode });
  });
  it("normalizes invalid kinetic jump modes without overwriting missing defaults", () => {
    expect(deserializeLyricSettings('{"kineticJumpGranularity":"invalid"}')).toMatchObject({
      kineticJumpGranularity: "auto",
    });
    expect(deserializeLyricSettings("{}")).not.toHaveProperty("kineticJumpGranularity");
  });
  it("falls back from unknown renderers without losing unrelated settings", () => {
    expect(
      deserializeLyricSettings('{"lyricRenderer":"future","useAMLyrics":true,"showRoma":false}'),
    ).toEqual({ lyricRenderer: "amll", showRoma: false });
  });
});
