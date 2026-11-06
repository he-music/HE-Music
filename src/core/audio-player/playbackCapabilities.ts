import { shallowRef } from "vue";
import type { EngineCapabilities } from "./IPlaybackEngine";

/** 只有引擎和音源能力变化更新，歌词时钟不进入设置的响应式依赖。 */
export const audioProcessingAvailable = shallowRef(false);
export const playbackCapabilities = shallowRef<EngineCapabilities>({
  supportsRate: true,
  supportsSinkId: false,
  supportsEqualizer: false,
  supportsSpectrum: false,
  supportsFade: false,
});
