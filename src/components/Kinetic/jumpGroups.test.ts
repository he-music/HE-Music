import { describe, expect, it } from "vitest";
import { adaptPartitaLines } from "../Partita/model";
import { buildKineticLayout, kineticImpact } from "./model";
import { buildKineticJumpGroups, KINETIC_MIN_JUMP_INTERVAL } from "./jumpGroups";
import type { KineticJumpGranularity } from "../../utils/lyric/kinetic";

function layout(
  text: string,
  mode: KineticJumpGranularity = "auto",
  duration = 5000,
  width = 3000,
  wordTimed = true,
) {
  return buildKineticLayout(
    adaptPartitaLines(
      [
        {
          startTime: 0,
          endTime: duration,
          words: [{ word: text, startTime: 0, endTime: duration }],
        },
      ],
      wordTimed,
    ),
    width,
    30,
    (text, size) => Array.from(text).length * size,
    {
      animate: true,
      jumpGranularity: mode,
      showTranslation: true,
      showRomanization: true,
      translationSize: 16,
      romanizationSize: 14,
    },
  );
}
function groups(text: string, mode: KineticJumpGranularity = "auto", duration = 5000) {
  const stage = layout(text, mode, duration);
  return buildKineticJumpGroups(stage.rows[0].glyphs, mode).map((group) =>
    group.map((glyph) => glyph.char).join(""),
  );
}

describe("kinetic landing granularity", () => {
  it("jumps on an English word once instead of nine letters", () => {
    const automatic = layout("beautiful", "auto", 400);
    const word = layout("beautiful", "word", 400);
    const character = layout("beautiful", "character", 400);
    expect(automatic.targets).toHaveLength(1);
    expect(word.targets).toHaveLength(1);
    expect(character.targets).toHaveLength(9);
    expect(word.targets[0]).toMatchObject({ start: 0, end: 400 });
    expect(word.targets[0].x).toBeCloseTo(1500, 0);
    // Landing mode must not change character timing, typography or camera behavior.
    expect(automatic.rows).toEqual(character.rows);
    expect(word.rows).toEqual(character.rows);
    expect(automatic.stops).toEqual(character.stops);
    expect(word.stops).toEqual(character.stops);
    expect(kineticImpact(word, 400)?.progress).toBeCloseTo(400 / 640);
  });
  it.each([
    ["听见 music 的声音", ["听", "见", "music", "的", "声", "音"]],
    ["君の music が好き", ["君", "の", "music", "が", "好", "き"]],
    ["안녕하세요 세상", ["안녕하세요", "세상"]],
    ["Bonjour le monde", ["Bonjour", "le", "monde"]],
    ["Привет мир", ["Привет", "мир"]],
    ["don't stop!", ["dont", "stop"]],
    ["cafe\u0301 👩‍👩‍👧‍👦", ["cafe\u0301", "👩‍👩‍👧‍👦"]],
  ])("segments mixed and non-English text: %s", (text, expected) => {
    expect(groups(text)).toEqual(expected);
  });
  it("groups Chinese words only in explicit word mode", () => {
    expect(groups("音乐世界", "auto")).toEqual(["音", "乐", "世", "界"]);
    expect(groups("音乐世界", "word")).toEqual(["音乐", "世界"]);
  });
  it("ignores punctuation and whitespace as standalone beats", () => {
    expect(groups("Hi,  world!", "word")).toEqual(["Hi", "world"]);
    expect(groups("Hi!", "character")).toEqual(["H", "i"]);
  });
  it("merges dense automatic landings but leaves explicit modes unrestricted", () => {
    const auto = layout("a b c d e f g h", "auto", 500);
    const word = layout("a b c d e f g h", "word", 500);
    expect(auto.targets.length).toBeLessThan(word.targets.length);
    expect(word.targets).toHaveLength(8);
    auto.targets.slice(1).forEach((target, index) => {
      expect(target.start - auto.targets[index].start).toBeGreaterThanOrEqual(
        KINETIC_MIN_JUMP_INTERVAL,
      );
    });
    expect(auto.rows).toEqual(word.rows);
    expect(auto.targets.at(-1)?.end).toBe(500);
  });
  it("preserves landing points on wrapped baselines", () => {
    const stage = layout("beautiful", "word", 900, 180);
    const split = buildKineticJumpGroups(stage.rows[0].glyphs, "word");
    expect(split.length).toBeGreaterThan(1);
    split.forEach((group) => expect(new Set(group.map((glyph) => glyph.rowY)).size).toBe(1));
    stage.targets.forEach((target) => expect(target.x).toBeGreaterThanOrEqual(0));
    stage.targets.forEach((target) => expect(target.x).toBeLessThanOrEqual(180));
  });
  it("leaves LRC and shaped paragraphs unchanged in every mode", () => {
    for (const mode of ["auto", "character", "word"] as const) {
      expect(layout("Hello world", mode, 5000, 3000, false).targets).toHaveLength(1);
      expect(layout("مرحبا بالعالم", mode).rows[0].glyphs).toHaveLength(0);
      expect(layout("مرحبا بالعالم", mode).targets).toHaveLength(1);
    }
  });
  it("does not infer word boundaries from backend timing-token boundaries", () => {
    const lines = adaptPartitaLines(
      [
        {
          startTime: 0,
          endTime: 2000,
          words: [
            { word: "beau", startTime: 0, endTime: 500 },
            { word: "tiful ", startTime: 500, endTime: 1000 },
            { word: "world", startTime: 1000, endTime: 2000 },
          ],
        },
      ],
      true,
    );
    const stage = buildKineticLayout(lines, 1000, 30, (t) => t.length * 30, {
      animate: true,
      jumpGranularity: "word",
      showTranslation: false,
      showRomanization: false,
      translationSize: 16,
      romanizationSize: 14,
    });
    expect(stage.targets).toHaveLength(2);
    expect(stage.targets.map((target) => target.start)).toEqual([0, 1000]);
  });
});
