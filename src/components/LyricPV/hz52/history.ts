import { createBeatDetector } from "../vendor/mods/visualizer52hz/beatDetector";
import {
  FAR_FROM_BEAT,
  HISTORY_RATE,
  HISTORY_SIZE,
} from "../vendor/mods/visualizer52hz/rippleFilter";
import type { HzAudio } from "./types";

// 移植 stage.mjs 的响度包络与节拍记录，用歌词时钟驱动，暂停与跳转均不依赖墙钟推进。
export class Hz52History {
  readonly energy = new Float32Array(HISTORY_SIZE);
  readonly beats = new Float32Array(HISTORY_SIZE).fill(FAR_FROM_BEAT);
  start = 0;
  private readonly detector = createBeatDetector();
  private peak = 0.2;
  private envelope = 0;
  private lastBeat = -Infinity;
  private lastSample: number | null = null;
  private lastTime: number | null = null;
  private lastWall: number | null = null;

  reset(time: number) {
    this.energy.fill(0);
    this.beats.fill(FAR_FROM_BEAT);
    this.start = time;
    this.lastSample = Math.floor(time * HISTORY_RATE);
    this.envelope = 0;
    this.lastBeat = -Infinity;
    this.detector.reset();
    this.synchronize(time, performance.now());
  }

  synchronize(time: number, wall: number) {
    this.lastTime = time;
    this.lastWall = wall;
  }

  seedStatic() {
    for (let i = 0; i < HISTORY_SIZE; i++) {
      this.energy[i] =
        0.2 + 0.45 * (0.5 + 0.5 * Math.sin(i * 0.13)) * (0.5 + 0.5 * Math.sin(i * 0.031));
      const phase = i / HISTORY_RATE / 0.72;
      this.beats[i] = Math.abs(phase - Math.round(phase)) * 0.72;
    }
    this.start = -1e9;
  }

  step(time: number, wall: number, audio: HzAudio | null): "reset" | "changed" | "idle" {
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    const wallDt = this.lastWall === null ? 0 : (wall - this.lastWall) / 1000;
    const jumped = this.lastTime === null || Math.abs(dt - wallDt) > 0.5;
    this.synchronize(time, wall);
    if (jumped) {
      this.reset(time);
      this.synchronize(time, wall);
      return "reset";
    }
    const sample = Math.floor(time * HISTORY_RATE);
    if (this.lastSample !== null && sample <= this.lastSample) return "idle";
    const raw = audio ? 0.6 * audio.getPower() + 0.4 * audio.getBands().bass : 0;
    const hasAudio = audio && ((audio.getSpectrum()?.length ?? 0) > 0 || raw > 0);
    // mpv 与预览没有频谱时保留清晰的基础年轮；真实静音频谱仍沿用原版的低能量。
    let value = 0.5;
    if (hasAudio) {
      this.peak = Math.max(raw, this.peak * Math.exp(-dt / 8), 0.08);
      const target = Math.min(1, raw / this.peak);
      const rate = target > this.envelope ? 1 - Math.exp(-dt / 0.03) : 1 - Math.exp(-dt / 0.35);
      this.envelope += (target - this.envelope) * rate;
      value = 0.06 + 0.94 * this.envelope;
    }
    const cellOf = (index: number) => ((index % HISTORY_SIZE) + HISTORY_SIZE) % HISTORY_SIZE;
    const first = Math.max((this.lastSample ?? sample) + 1, sample - HISTORY_SIZE + 1);
    for (let index = first; index <= sample; index++) {
      this.energy[cellOf(index)] = value;
      this.beats[cellOf(index)] = Math.min(FAR_FROM_BEAT, index / HISTORY_RATE - this.lastBeat);
    }
    if (hasAudio ? this.detector.step(audio, time, dt, 1) : time - this.lastBeat >= 0.72) {
      this.lastBeat = sample / HISTORY_RATE;
      const oldest = Math.max(
        sample - Math.round(0.5 * HISTORY_RATE),
        Math.ceil(this.start * HISTORY_RATE),
      );
      for (let index = sample; index >= oldest; index--) {
        const cell = cellOf(index);
        this.beats[cell] = Math.min(this.beats[cell], (sample - index) / HISTORY_RATE);
      }
    }
    this.lastSample = sample;
    return "changed";
  }
}
