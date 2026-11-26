import { expect, it } from "vitest";
import { replayGainScale, trackReplayGainDb } from "./replayGain";

it("按 dB 换算；正增益不会超过线性峰值留出的空间", () => {
  expect(replayGainScale(trackReplayGainDb({ track_gain_db: -6 }))).toBeCloseTo(0.501);
  expect(replayGainScale(trackReplayGainDb({ track_gain_db: 12, track_peak: 0.5 }))).toBe(2);
  expect(replayGainScale(trackReplayGainDb({ track_gain_db: 0, track_peak: 1.25 }))).toBeCloseTo(
    0.8,
  );
});

it("无增益或增益无效时保持原电平，无可信峰值时只允许衰减", () => {
  expect(trackReplayGainDb()).toBe(0);
  expect(trackReplayGainDb({ track_peak: 0.5 })).toBe(0);
  expect(trackReplayGainDb({ track_gain_db: Number.NaN })).toBe(0);
  expect(trackReplayGainDb({ track_gain_db: 6 })).toBe(0);
  expect(trackReplayGainDb({ track_gain_db: 6, track_peak: 0 })).toBe(0);
  expect(trackReplayGainDb({ track_gain_db: -4 })).toBe(-4);
});
