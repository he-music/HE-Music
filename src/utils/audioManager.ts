/**
 * @file AudioManager.ts
 * @description 对业务提供稳定的播放、事件和音频处理兼容入口
 * @author imsyy
 */

import {
  audioProcessingAvailable,
  playbackCapabilities,
} from "@/core/audio-player/playbackCapabilities";
export {
  audioProcessingAvailable,
  playbackCapabilities,
} from "@/core/audio-player/playbackCapabilities";
import { BrowserPlaybackEngine } from "@/core/audio-player/BrowserPlaybackEngine";
import { MpvPlaybackEngine } from "@/core/audio-player/MpvPlaybackEngine";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
import {
  audioEventTypes,
  type AudioEventType,
  type EngineCapabilities,
  type IPlaybackEngine,
  type PauseOptions,
  type PlayOptions,
  type PlaybackEvent,
} from "@/core/audio-player/IPlaybackEngine";

export type { AudioEventType } from "@/core/audio-player/IPlaybackEngine";

function isAudioEvent(type: PlaybackEvent["type"]): type is AudioEventType {
  return audioEventTypes.some((event) => event === type);
}

/** 兼容门面不持有 HTMLAudioElement、AudioContext 或输出路由。 */
export class AudioManager {
  private readonly eventListeners = new Map<AudioEventType, Set<(event: Event) => void>>();
  private unsubscribe: () => void;
  private readonly engineListeners = new Set<(event: PlaybackEvent) => void>();
  private switchTail: Promise<void> = Promise.resolve();
  private pendingSwitches = 0;
  private eventRevision = 0;

  constructor(private engine: IPlaybackEngine = new BrowserPlaybackEngine()) {
    this.unsubscribe = engine.onEvent((event) => {
      if (this.engine === engine) this.forward(event);
    });
    this.syncCapabilities();
  }

  public setEngine(id: PlaybackEngineId): Promise<void> {
    ++this.pendingSwitches;
    const switchEngine = async () => {
      if (this.engine.id === id) {
        await this.engine.init();
        return;
      }
      ++this.eventRevision;
      this.unsubscribe();
      await this.engine.clearSource();
      await this.engine.destroy();
      if (id === "mpv") {
        const { platform } = await import("@/platform");
        if (!platform.mpvPlayback) throw new Error("mpv unavailable");
        this.engine = new MpvPlaybackEngine(platform.mpvPlayback);
      } else {
        this.engine = new BrowserPlaybackEngine();
      }
      const engine = this.engine;
      this.unsubscribe = engine.onEvent((event) => {
        if (this.engine === engine) this.forward(event);
      });
      this.syncCapabilities();
      await engine.init();
    };
    const result = this.switchTail.then(switchEngine).finally(() => {
      --this.pendingSwitches;
    });
    this.switchTail = result.catch(() => undefined);
    return result;
  }
  public init(): Promise<void> {
    return this.engine.init();
  }

  public async destroy(): Promise<void> {
    this.unsubscribe();
    this.offAll();
    this.engineListeners.clear();
    await this.engine.destroy();
    this.syncCapabilities();
  }

  public async play(url?: string, options: PlayOptions = {}): Promise<void> {
    try {
      await this.engine.play(url, options);
    } catch (error) {
      console.error("AudioManager: 播放失败", error);
      throw error;
    }
  }

  public pause(options: PauseOptions = {}): Promise<void> {
    return this.engine.pause(options);
  }

  public toggle(): Promise<void> {
    return this.paused ? this.play() : this.pause();
  }

  public stop(): Promise<void> {
    return this.engine.stop();
  }

  /** 清空已撤销的本地音源，同时释放已缓冲的字节和读取句柄。 */
  public clearSource(): Promise<void> {
    if (this.pendingSwitches) return this.switchTail.then(() => this.engine.clearSource());
    return this.engine.clearSource();
  }

  public seek(time: number): Promise<void> {
    return this.engine.seek(time);
  }

  public setVolume(value: number): Promise<void> {
    return this.engine.setVolume(value);
  }

  public getVolume(): number {
    return this.engine.getVolume();
  }

  public setRate(value: number): Promise<void> {
    return this.engine.setRate(value);
  }

  public getRate(): number {
    return this.engine.getRate();
  }

  public setSinkId(deviceId: string): Promise<void> {
    return this.engine.setSinkId(deviceId);
  }

  public getOutputDevices() {
    return this.engine.getOutputDevices();
  }

  public setFilterGain(index: number, value: number): void {
    this.engine.setFilterGain?.(index, value);
  }

  public getFilterGains(): number[] {
    return [...(this.engine.getFilterGains?.() ?? [])];
  }

  public getFrequencyData(): Uint8Array {
    return this.engine.getFrequencyData?.() ?? new Uint8Array(0);
  }

  public on(event: AudioEventType, callback: (event: Event) => void): void {
    const listeners = this.eventListeners.get(event) ?? new Set<(event: Event) => void>();
    listeners.add(callback);
    this.eventListeners.set(event, listeners);
  }

  public off(event: AudioEventType, callback: (event: Event) => void): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  public offAll(): void {
    this.eventListeners.clear();
  }

  public onEngineEvent(listener: (event: PlaybackEvent) => void): () => void {
    this.engineListeners.add(listener);
    return () => this.engineListeners.delete(listener);
  }

  public get engineId() {
    return this.engine.id;
  }

  public get capabilities(): EngineCapabilities {
    return this.engine.capabilities;
  }

  public get error() {
    return this.engine.error;
  }
  public get state() {
    return this.engine.state;
  }

  public get duration(): number {
    return this.engine.duration;
  }

  public get currentTime(): number {
    return this.engine.currentTime;
  }

  /** 过渡期保留浏览器缓冲快照，其他引擎按统一状态映射。 */
  public get readyState(): number {
    if (this.engine.readyState !== undefined) return this.engine.readyState;
    switch (this.state) {
      case "playing":
      case "paused":
      case "ended":
        return 4;
      case "buffering":
        return 2;
      default:
        return 0;
    }
  }

  public get paused(): boolean {
    return this.engine.paused;
  }

  public get src(): string {
    return this.engine.src;
  }

  /** 错误仍保留 kind；仅在兼容旧的资源恢复流程时转换为媒体错误码。 */
  public getErrorCode(): number {
    const error = this.engine.error;
    if (!error) return 0;
    if (error.mediaErrorCode !== undefined) {
      return error.mediaErrorCode >= 1 && error.mediaErrorCode <= 4 ? error.mediaErrorCode : 0;
    }
    switch (error.kind) {
      case "network":
        return 2;
      case "decode":
        return 3;
      case "source":
        return 4;
      default:
        return 0;
    }
  }

  private forward(event: PlaybackEvent): void {
    if (this.pendingSwitches) return;
    if (event.sessionId !== this.engine.sessionId) return;
    for (const listener of this.engineListeners) listener(event);
    if (this.pendingSwitches || event.sessionId !== this.engine.sessionId) return;
    if (event.type === "capabilitieschange") {
      // 同一音源从图谱降级到普通元素时，session 不变，但旧 owner 的分发必须结束。
      ++this.eventRevision;
      this.syncCapabilities();
    }
    const revision = this.eventRevision;
    if (!isAudioEvent(event.type)) return;
    const forwarded =
      event.type === "error"
        ? new CustomEvent("error", {
            detail: {
              originalEvent: event.originalEvent,
              errorCode: this.getErrorCode(),
              errorMessage: event.error?.message ?? "",
            },
          })
        : (event.originalEvent ?? new Event(event.type));
    for (const listener of [...(this.eventListeners.get(event.type) ?? [])]) {
      if (event.sessionId !== this.engine.sessionId || revision !== this.eventRevision) break;
      listener(forwarded);
    }
  }

  private syncCapabilities(): void {
    const next = this.engine.capabilities;
    const current = playbackCapabilities.value;
    if (
      current.supportsRate !== next.supportsRate ||
      current.supportsSinkId !== next.supportsSinkId ||
      current.supportsEqualizer !== next.supportsEqualizer ||
      current.supportsSpectrum !== next.supportsSpectrum ||
      current.supportsFade !== next.supportsFade
    ) {
      playbackCapabilities.value = next;
    }
    audioProcessingAvailable.value = next.supportsEqualizer && next.supportsSpectrum;
  }
}

export default new AudioManager();
