import { describe, expect, it } from "vitest";
import { adaptPartitaLines } from "../Partita/model";
import {
  buildKineticLayout,
  kineticCamera,
  kineticImpact,
  kineticNote,
  kineticTrail,
} from "./model";

const source = [
  {
    startTime: 0,
    endTime: 3000,
    words: [
      { word: "让", startTime: 0, endTime: 1000 },
      { word: "音乐", startTime: 1000, endTime: 2000 },
      { word: "飞", startTime: 2000, endTime: 3000 },
    ],
    translatedLyric: "Let the music fly",
  },
  {
    startTime: 3300,
    endTime: 6500,
    words: [
      { word: "跃", startTime: 3300, endTime: 4500 },
      { word: "动", startTime: 4500, endTime: 6500 },
    ],
  },
];
const options = {
  animate: true,
  translationSize: 18,
  romanizationSize: 16,
  showTranslation: true,
  showRomanization: true,
};
const measure = (text: string, size: number) => Array.from(text).length * size;
const layout = (width = 600, wordTimed = true, animate = true) =>
  buildKineticLayout(adaptPartitaLines(source, wordTimed), width, 40, measure, {
    ...options,
    animate,
  });

describe("kinetic lyrics timeline", () => {
  it("lands precisely on subdivided source graphemes", () => {
    const stage = layout();
    expect(stage.targets.map((target) => target.start)).toEqual([0, 1000, 1500, 2000, 3300, 4500]);
    for (const target of stage.targets) {
      expect(kineticNote(stage, target.start, 40)).toMatchObject({
        x: target.x,
        y: target.y,
        rotation: 0,
      });
    }
  });
  it("uses an elevated arc between timed glyphs", () => {
    const stage = layout();
    const pose = kineticNote(stage, 500, 40)!;
    expect(pose.x).toBeCloseTo((stage.targets[0].x + stage.targets[1].x) / 2);
    expect(pose.y).toBeLessThan((stage.targets[0].y + stage.targets[1].y) / 2);
  });
  it.each([300, 950, 1500, 2200, 3000])("keeps the note visible across a %ims line gap", (gap) => {
    const nextStart = 200 + gap;
    const stage = buildKineticLayout(
      adaptPartitaLines(
        [
          { startTime: 0, endTime: 200, words: [{ word: "前", startTime: 0, endTime: 200 }] },
          {
            startTime: nextStart,
            endTime: nextStart + 1000,
            words: [{ word: "后", startTime: nextStart, endTime: nextStart + 1000 }],
          },
        ],
        true,
      ),
      400,
      40,
      measure,
      options,
    );
    for (let time = 0; time <= nextStart; time += 10) {
      expect(kineticNote(stage, time, 40)?.opacity).toBe(1);
    }
    const before = kineticNote(stage, nextStart - 0.001, 40)!;
    const landed = kineticNote(stage, nextStart, 40)!;
    expect(before.x).toBeCloseTo(landed.x, 2);
    expect(before.y).toBeCloseTo(landed.y, 2);
  });
  it("draws connected history with fading, tapering segments and clears it on seeks", () => {
    const stage = layout();
    const trail = kineticTrail(stage, 800, 40);
    expect(trail).toHaveLength(24);
    trail.slice(1).forEach((segment, index) => {
      expect(segment.x1).toBe(trail[index].x2);
      expect(segment.y1).toBe(trail[index].y2);
      expect(segment.opacity).toBeGreaterThan(trail[index].opacity);
      expect(segment.width).toBeGreaterThan(trail[index].width);
    });
    const pose = kineticNote(stage, 800, 40)!;
    expect(trail.at(-1)).toMatchObject({ x2: pose.x, y2: pose.y });
    expect(kineticTrail(stage, 800, 40)).toEqual(trail);
    expect(kineticTrail(stage, 800, 40, 800)).toEqual([]);
    expect(kineticTrail(stage, 830, 40, 800)).toHaveLength(2);
    expect(kineticTrail(stage, 9000, 40)).toEqual([]);
  });
  it("keeps a single landing pose expanding for 640ms without inventing LRC impacts", () => {
    const stage = layout();
    expect(kineticImpact(stage, 0)).toMatchObject({ progress: 0 });
    expect(kineticImpact(stage, 320)).toMatchObject({ progress: 0.5 });
    expect(kineticImpact(stage, 640)).toBeNull();
    expect(kineticImpact(layout(600, false), 0)).toBeNull();
  });
  it("holds long notes in place, freezes on pause, and reproduces seeks", () => {
    const stage = layout();
    const pose = kineticNote(stage, 5200, 40);
    expect(pose).toMatchObject({ x: stage.targets.at(-1)!.x, y: stage.targets.at(-1)!.y });
    expect(pose!.glow).toBeGreaterThan(1);
    kineticNote(stage, 6000, 40);
    expect(kineticNote(stage, 5200, 40)).toEqual(pose);
    expect(kineticNote(stage, 5200, 40)).toEqual(pose);
  });
  it("fades after the final note and does not bridge a long instrumental gap", () => {
    const stage = layout();
    expect(kineticNote(stage, -1, 40)).toBeNull();
    expect(kineticNote(stage, 7200, 40)).toBeNull();
    const spaced = buildKineticLayout(
      adaptPartitaLines(
        [
          source[0],
          {
            ...source[1],
            startTime: 10000,
            endTime: 15000,
            words: [{ word: "归来", startTime: 10000, endTime: 15000 }],
          },
        ],
        true,
      ),
      600,
      40,
      measure,
      options,
    );
    expect(kineticNote(spaced, 9000, 40)).toBeNull();
    expect(spaced.rows.some((row) => row.line.isInterlude)).toBe(true);
  });
  it("follows wrapped baselines continuously without letter jitter", () => {
    const stage = layout(150);
    expect(stage.stops.length).toBeGreaterThan(stage.rows.length);
    const stop = stage.stops[1];
    const before = kineticCamera(stage, stop.time - 0.01).y;
    const after = kineticCamera(stage, stop.time).y;
    expect(before).toBeCloseTo(after, 4);
    expect(after).toBe(stop.y);
    expect(kineticCamera(stage, 0).y).toBe(kineticCamera(stage, 100).y);
  });
  it("reserves wrapped subtitles so adjacent rows cannot overlap", () => {
    const stage = layout(180);
    const first = stage.rows[0];
    expect(first.translation.length).toBeGreaterThan(1);
    expect(stage.rows[1].y).toBeGreaterThan(first.y + first.height);
  });
  it("keeps LRC and disabled word effects as paragraphs without fake beats", () => {
    for (const stage of [layout(600, false), layout(600, true, false)]) {
      expect(stage.targets).toHaveLength(2);
      expect(stage.rows[0].glyphs).toHaveLength(0);
      expect(stage.rows[0].paragraphs).toEqual(["让音乐飞"]);
      const start = stage.targets[0];
      expect(kineticNote(stage, 1000, 40)).toMatchObject({ x: start.x, y: start.y });
    }
  });
  it("preserves emoji clusters and joining-script shaping", () => {
    const emoji = buildKineticLayout(
      adaptPartitaLines(
        [{ startTime: 0, endTime: 1000, words: [{ word: "👩‍👩‍👧‍👦好", startTime: 0, endTime: 1000 }] }],
        true,
      ),
      600,
      40,
      measure,
      options,
    );
    expect(emoji.rows[0].glyphs.map((glyph) => glyph.char)).toEqual(["👩‍👩‍👧‍👦", "好"]);
    const arabic = buildKineticLayout(
      adaptPartitaLines(
        [{ startTime: 0, endTime: 1000, words: [{ word: "مرحبا", startTime: 0, endTime: 1000 }] }],
        true,
      ),
      600,
      40,
      measure,
      options,
    );
    expect(arabic.rows[0].glyphs).toHaveLength(0);
    expect(arabic.rows[0].paragraphs).toEqual(["مرحبا"]);
  });
  it("reduces motion to a stationary indicator and discrete camera", () => {
    const stage = layout();
    expect(kineticNote(stage, 675, 40, true)).toMatchObject({
      x: stage.targets[0].x,
      y: stage.targets[0].y,
      rotation: 0,
      glow: 1,
    });
    expect(kineticCamera(stage, 3100, true).progress).toBe(0);
  });
  it("handles empty lyrics and overlapping vocals", () => {
    const empty = buildKineticLayout([], 0, 40, measure, options);
    expect(kineticNote(empty, 0, 40)).toBeNull();
    expect(kineticCamera(empty, 0).row).toBe(-1);
    const duet = buildKineticLayout(
      adaptPartitaLines(
        [
          source[0],
          { ...source[1], startTime: 500, words: [{ word: "和", startTime: 500, endTime: 1000 }] },
        ],
        true,
      ),
      150,
      40,
      measure,
      options,
    );
    expect(duet.targets.map((target) => target.start)).toEqual(
      [...duet.targets.map((target) => target.start)].sort((a, b) => a - b),
    );
    expect(duet.stops.every((stop) => stop.moveStart <= stop.time)).toBe(true);
  });
});
