import audioManager from "@/utils/audioManager";
import type { AudioBands, MotionValue } from "./vendor/types";

// 复用播放器现有频谱；同一帧只采样一次，不创建 AudioContext、定时器或响应式高频状态。
export function createPVAudioSignals(enabled: () => boolean) {
  let sampledAt = -Infinity;
  let spectrum: Uint8Array = new Uint8Array(0);
  const frame = { bass: 0, mid: 0, treble: 0, vocal: 0, power: 0 };
  const signal = (key: keyof typeof frame): MotionValue<number> => ({
    get() {
      if (!enabled()) return 0;
      const now = performance.now();
      if (now - sampledAt >= 12) {
        sampledAt = now;
        const data = audioManager.getFrequencyData();
        spectrum = data;
        const average = (from: number, to: number) => {
          const start = Math.floor(data.length * from);
          const end = Math.floor(data.length * to);
          let total = 0;
          for (let i = start; i < end; i++) total += data[i];
          return end > start ? total / ((end - start) * 255) : 0;
        };
        frame.bass = average(0, 0.08);
        frame.mid = average(0.08, 0.4);
        frame.vocal = average(0.04, 0.25);
        frame.treble = average(0.4, 1);
        frame.power = average(0, 1);
      }
      return frame[key];
    },
  });
  const audioBands: AudioBands = {
    bass: signal("bass"),
    mid: signal("mid"),
    treble: signal("treble"),
    vocal: signal("vocal"),
  };
  const audioPower = signal("power");
  return {
    audioPower,
    audioBands,
    audioSpectrum: () => {
      if (!enabled()) return null;
      audioPower.get();
      return spectrum;
    },
  };
}
