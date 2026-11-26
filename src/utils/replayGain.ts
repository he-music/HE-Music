export interface ReplayGain {
  readonly track_gain_db?: number;
  readonly track_peak?: number;
}

function validGain(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 60;
}

function validPeak(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= 10;
}

export function parseReplayGain(
  value: unknown,
): (ReplayGain & { track_gain_db: number }) | undefined {
  if (typeof value !== "object" || value === null || !("track_gain_db" in value)) return;
  if (!validGain(value.track_gain_db)) return;
  return {
    track_gain_db: value.track_gain_db,
    ...("track_peak" in value && validPeak(value.track_peak)
      ? { track_peak: value.track_peak }
      : {}),
  };
}

/** 将建议增益限制在音源峰值留出的空间内；未知峰值时不放大。 */
export function trackReplayGainDb(replayGain?: ReplayGain): number {
  const gain = replayGain?.track_gain_db;
  if (!validGain(gain)) return 0;
  const peak = replayGain?.track_peak;
  if (!validPeak(peak)) return Math.min(gain, 0);
  return Math.min(gain, -20 * Math.log10(peak));
}

export function replayGainScale(db: number): number {
  return 10 ** (db / 20);
}
