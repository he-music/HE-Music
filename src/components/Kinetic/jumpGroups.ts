import type { KineticGlyph } from "./model";
import {
  resolveKineticJumpGranularity,
  type KineticJumpGranularity,
} from "../../utils/lyric/kinetic";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const characterScripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const silent = /^[\p{White_Space}\p{Punctuation}]+$/u;
export const KINETIC_MIN_JUMP_INTERVAL = 160;

/** Derive visual landings without changing source glyphs, highlighting or camera stops. */
export function buildKineticJumpGroups(
  glyphs: KineticGlyph[],
  selection: KineticJumpGranularity,
): KineticGlyph[][] {
  const mode = resolveKineticJumpGranularity(selection);
  const groups: KineticGlyph[][] = [];
  if (mode === "character") {
    for (const glyph of glyphs) if (!silent.test(glyph.char)) groups.push([glyph]);
    return groups;
  }
  const text = glyphs.map((glyph) => glyph.char).join("");
  let index = 0;
  let offset = 0;
  for (const segment of wordSegmenter.segment(text)) {
    const end = segment.index + segment.segment.length;
    let group: KineticGlyph[] = [];
    const flush = () => {
      if (group.length) groups.push(group);
      group = [];
    };
    while (index < glyphs.length && offset < end) {
      const glyph = glyphs[index++];
      offset += glyph.char.length;
      if (silent.test(glyph.char)) continue;
      // Words spanning visual rows need a landing on each baseline, never in the gap.
      if (group.length && group[0].rowY !== glyph.rowY) flush();
      if (mode === "auto" && characterScripts.test(glyph.char)) {
        flush();
        groups.push([glyph]);
      } else group.push(glyph);
    }
    flush();
  }
  if (mode === "word") return groups;
  const merged: KineticGlyph[][] = [];
  for (const group of groups) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous[0].rowY === group[0].rowY &&
      group[0].startTime >= previous[0].startTime &&
      group[0].startTime - previous[0].startTime < KINETIC_MIN_JUMP_INTERVAL
    ) {
      previous.push(...group);
    } else merged.push([...group]);
  }
  return merged;
}
