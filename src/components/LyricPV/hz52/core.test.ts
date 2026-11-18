import { describe, expect, it } from "vitest";
import { MpvPlaybackClock } from "@/core/audio-player/MpvPlaybackClock";
import { createBeatDetector } from "../vendor/mods/visualizer52hz/beatDetector";
import { computeDistanceField } from "../vendor/mods/visualizer52hz/distanceField";
import { pithOutline } from "../vendor/mods/visualizer52hz/pithShape";
import type { Line } from "../vendor/types";
import { Hz52History } from "./history";
import { find52HzLineIndex } from "./source";
import { buildCharTimings } from "./timing";

// 保护移植后的节拍、跳转、字形边界与音节时间，有频谱时保持音乐驱动，无频谱时仍沿歌词时钟生长。
const line: Line = {
  fullText: "你 好👩‍🚀",
  startTime: 2,
  endTime: 8,
  words: [
    {
      text: "你 好👩‍🚀",
      startTime: 2,
      endTime: 8,
      syllables: [
        { text: "你", startTime: 2, endTime: 3 },
        { text: " ", startTime: 3, endTime: 3 },
        { text: "好", startTime: 3, endTime: 4 },
        { text: "👩‍🚀", startTime: 4, endTime: 8 },
      ],
    },
  ],
};

it("keeps syllable timing and combined emoji aligned with rendered glyphs", () => {
  expect(buildCharTimings(line)).toEqual([
    { start: 2, end: 3 },
    null,
    { start: 3, end: 4 },
    { start: 4, end: 8 },
  ]);
  expect(
    buildCharTimings({ ...line, words: [{ text: line.fullText, startTime: 2, endTime: 2 }] }),
  ).toEqual([null, null, null, null]);
});

it("stops lyric sources during gaps and selects the right line after a backward seek", () => {
  const lines = [line, { ...line, startTime: 12, endTime: 16 }];
  expect([1, 2, 8, 11, 12, 16, 3].map((time) => find52HzLineIndex(lines, time))).toEqual([
    -1, 0, -1, -1, 1, -1, 0,
  ]);
  expect(find52HzLineIndex([], 5)).toBe(-1);
});

it("computes Euclidean distances from the glyph outline", () => {
  expect(
    Array.from(computeDistanceField(new Uint8Array([0, 0, 0, 0, 255, 0, 0, 0, 0]), 3, 3)),
  ).toEqual([
    Math.fround(Math.SQRT2),
    1,
    Math.fround(Math.SQRT2),
    1,
    0,
    1,
    Math.fround(Math.SQRT2),
    1,
    Math.fround(Math.SQRT2),
  ]);
  expect(pithOutline(12, 640, 400)).toEqual(pithOutline(12, 640, 400));
  expect(pithOutline(13, 640, 400)).not.toEqual(pithOutline(12, 640, 400));
});

describe("52Hz beat-driven ring history", () => {
  const detect = (flat: boolean) => {
    const detector = createBeatDetector();
    const spectrum = new Uint8Array(1024);
    const audio = {
      getPower: () => 0,
      getBands: () => ({ bass: 0, lowMid: 0 }),
      getSpectrum: () => spectrum,
    };
    const beats: number[] = [];
    for (let frame = 0; frame < 12 * 60; frame++) {
      const time = frame / 60;
      const kick = flat ? 0 : Math.exp(-(time % 0.5) / 0.08);
      for (let bin = 1; bin <= 12; bin++) spectrum[bin] = Math.round(60 + 180 * kick);
      if (detector.step(audio, time, 1 / 60, 1)) beats.push(time);
    }
    return beats.filter((time) => time >= 2);
  };

  it("finds the 120 BPM kicks and uses sparse filler beats for a flat spectrum", () => {
    const beats = detect(false);
    expect(beats.length).toBeGreaterThanOrEqual(19);
    expect(beats.length).toBeLessThanOrEqual(21);
    beats.forEach((time) => expect(Math.min(time % 0.5, 0.5 - (time % 0.5))).toBeLessThan(0.05));
    const flat = detect(true);
    flat.slice(1).forEach((time, index) => expect(time - flat[index]).toBeGreaterThanOrEqual(1.9));
  });

  it("retains history after a long pause, clears it on seek, and ignores stalls", () => {
    const history = new Hz52History();
    expect(history.step(0, 0, null)).toBe("reset");
    history.step(0.1, 100, null);
    expect(history.energy.some((value) => value > 0)).toBe(true);
    history.synchronize(0.1, 30000);
    expect(history.step(0.2, 30100, null)).toBe("changed");
    expect(history.start).toBe(0);
    expect(history.step(1.2, 31100, null)).toBe("changed");
    expect(history.step(0.5, 31200, null)).toBe("reset");
    expect(history.start).toBe(0.5);
    expect(history.energy.every((value) => value === 0)).toBe(true);
    expect(history.step(9, 31300, null)).toBe("reset");
    history.seedStatic();
    expect(history.energy.every((value) => value > 0)).toBe(true);
  });

  it("keeps true silence quiet when a real spectrum is available", () => {
    const history = new Hz52History();
    const audio = {
      getPower: () => 0,
      getBands: () => ({ bass: 0, lowMid: 0 }),
      getSpectrum: () => new Uint8Array(1024),
    };
    for (let frame = 0; frame < 240; frame++) history.step(frame / 60, (frame * 1000) / 60, audio);
    expect(Math.max(...history.energy)).toBeLessThan(0.061);
    expect(Array.from(history.beats).filter((value) => value === 0).length).toBeLessThanOrEqual(2);
  });

  it("keeps growing across small mpv snapshot clock corrections without spectrum", () => {
    let wall = 0;
    const clock = new MpvPlaybackClock(() => wall);
    const history = new Hz52History();
    const audio = {
      getPower: () => 0,
      getBands: () => ({ bass: 0, lowMid: 0 }),
      getSpectrum: () => new Uint8Array(0),
    };
    let resets = 0;
    for (let frame = 0; frame < 300; frame++) {
      wall = (frame * 1000) / 60;
      if (frame % 12 === 0) {
        clock.update({
          position: Math.max(0, frame / 60 - (frame % 24 ? 0.04 : 0)),
          duration: 180,
          rate: 1,
          state: "playing",
        });
      }
      if (history.step(clock.currentTime, wall, audio) === "reset") resets++;
    }
    expect(resets).toBe(1);
    expect(history.start).toBe(0);
    expect(Math.max(...history.energy)).toBeGreaterThanOrEqual(0.35);
    const beats = Array.from(history.beats).filter((value) => value === 0);
    expect(beats.length).toBeGreaterThanOrEqual(6);
  });
});
