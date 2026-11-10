import { shallowRef } from "vue";
import type { EngineCapabilities, PlaybackEngineId } from "./IPlaybackEngine";
import type { AudioDecryption } from "@/platform/audioSource";

/** 仅在切换引擎或音源时更新，供歌曲信息展示使用。 */
export const activePlaybackEngine = shallowRef<PlaybackEngineId>("web-audio");
export const playbackDecryption = shallowRef<AudioDecryption>(null);

/** 只有引擎和音源能力变化更新，歌词时钟不进入设置的响应式依赖。 */
export const audioProcessingAvailable = shallowRef(false);
export const playbackCapabilities = shallowRef<EngineCapabilities>({
  supportsRate: true,
  supportsSinkId: false,
  supportsEqualizer: false,
  supportsSpectrum: false,
  supportsFade: false,
});
