import type { AudioSourceInfo } from "@/utils/audioCapability";

export type PlaybackEngineId = "web-audio" | "mpv";

export interface EngineCapabilities {
  readonly supportsRate: boolean;
  readonly supportsSinkId: boolean;
  readonly supportsEqualizer: boolean;
  readonly supportsSpectrum: boolean;
  readonly supportsFade: boolean;
}

export type PlaybackState =
  "idle" | "loading" | "paused" | "playing" | "buffering" | "ended" | "error";

export interface PlayOptions {
  readonly autoPlay?: boolean;
  readonly seek?: number;
  readonly fadeIn?: boolean;
  readonly fadeDuration?: number;
  readonly source?: AudioSourceInfo;
}

export interface PauseOptions {
  readonly fadeOut?: boolean;
  readonly fadeDuration?: number;
}

export interface PlaybackError {
  readonly kind: "source" | "network" | "decode" | "device" | "engine";
  readonly message: string;
  /** 浏览器错误码仅供现有恢复逻辑过渡使用，原生错误仍保留 kind。 */
  readonly mediaErrorCode?: number;
}

export const audioEventTypes = [
  "play",
  "playing",
  "pause",
  "ended",
  "timeupdate",
  "error",
  "waiting",
  "stalled",
  "canplay",
  "loadedmetadata",
  "loadstart",
  "volumechange",
  "seeking",
  "seeked",
  "processingchange",
] as const;
export type AudioEventType = (typeof audioEventTypes)[number];

export type PlaybackEventType =
  AudioEventType | "statechange" | "capabilitieschange" | "deviceschange";

export interface PlaybackEvent {
  readonly type: PlaybackEventType;
  readonly sessionId: number;
  readonly originalEvent?: Event;
  readonly error?: PlaybackError;
}

export interface AudioOutputDevice {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export interface IPlaybackEngine {
  readonly id: PlaybackEngineId;
  readonly capabilities: EngineCapabilities;
  readonly state: PlaybackState;
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly src: string;
  /** 音源代次；替换和清空音源时递增，旧事件不得跨代转发。 */
  readonly sessionId: number;
  readonly error: PlaybackError | undefined;
  /** 浏览器缓冲快照；其他引擎由兼容门面按 state 映射。 */
  readonly readyState?: number;

  init(): Promise<void>;
  destroy(): Promise<void>;
  /** 完成表示音源已交给引擎且播放请求已处理；被更新意图取消时正常完成。 */
  play(url?: string, options?: PlayOptions): Promise<void>;
  /** 渐出结束或被后续命令取消后完成，取消不产生播放错误。 */
  pause(options?: PauseOptions): Promise<void>;
  stop(): Promise<void>;
  clearSource(): Promise<void>;
  /** 完成表示命令已接受；实际位置确认由 seeked 或后续快照提供。 */
  seek(seconds: number): Promise<void>;
  setVolume(value: number): Promise<void>;
  getVolume(): number;
  setRate(rate: number): Promise<void>;
  getRate(): number;
  getOutputDevices(): Promise<readonly AudioOutputDevice[]>;
  setSinkId(deviceId: string): Promise<void>;
  onEvent(listener: (event: PlaybackEvent) => void): () => void;

  setFilterGain?(index: number, value: number): void;
  getFilterGains?(): readonly number[];
  getFrequencyData?(): Uint8Array;
}
