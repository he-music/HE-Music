import {
  AudioProcessingDriver,
  type AudioDriverEvent,
  type AudioProcessingDriverOptions,
} from "@/utils/audioCapability";
import { AudioOutputRouter } from "@/utils/audioOutput";
import {
  audioEventTypes,
  type AudioOutputDevice,
  type EngineCapabilities,
  type IPlaybackEngine,
  type PauseOptions,
  type PlayOptions,
  type PlaybackError,
  type PlaybackEvent,
  type PlaybackEventType,
  type PlaybackState,
} from "./IPlaybackEngine";

const frequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export interface BrowserPlaybackEngineOptions extends Partial<
  Pick<AudioProcessingDriverOptions, "createElement" | "probe" | "createGraph" | "probeTimeoutMs">
> {
  readonly frequencies?: readonly number[];
  readonly volume?: number;
}

/** 浏览器播放、处理图谱与输出路由的唯一所有者。 */
export class BrowserPlaybackEngine implements IPlaybackEngine {
  readonly id = "web-audio";

  private readonly output: AudioOutputRouter;
  private readonly driver: AudioProcessingDriver;
  private readonly listeners = new Set<(event: PlaybackEvent) => void>();
  private readonly desiredGains: number[];
  private volume: number;
  private revision = 0;
  private fade: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;
  private destroyed = false;
  private loading = false;
  private buffering = false;
  private capabilitySnapshot: EngineCapabilities | undefined;
  private selectedSink = "";
  private deviceError?: PlaybackError;
  private readonly deviceChange = () => {
    const selected = this.selectedSink;
    if (!selected || selected === "default" || this.destroyed) return;
    void this.getOutputDevices()
      .then(async (devices) => {
        if (this.destroyed || selected !== this.selectedSink) return;
        this.emit("deviceschange");
        if (devices.some((device) => device.id === selected && device.available)) return;
        this.deviceError = { kind: "device", message: "Selected audio output is unavailable" };
        await this.pause();
        this.emit("error");
      })
      .catch(async () => {
        if (this.destroyed || selected !== this.selectedSink) return;
        this.deviceError = { kind: "device", message: "Failed to read output devices" };
        await this.pause();
        this.emit("error");
      });
  };

  constructor(options: BrowserPlaybackEngineOptions = {}) {
    this.volume = Math.max(0, Math.min(1, options.volume ?? 1));
    this.desiredGains = Array<number>((options.frequencies ?? frequencies).length).fill(0);
    this.output = new AudioOutputRouter(options.createElement);
    this.driver = new AudioProcessingDriver({
      createElement: options.createElement ?? (() => new Audio()),
      frequencies: options.frequencies ?? frequencies,
      volume: this.volume,
      probe: options.probe,
      probeTimeoutMs: options.probeTimeoutMs,
      createGraph: options.createGraph,
      prepareOutput: (element, context) => {
        this.output.setSource(element, context, this.driver.gain);
        return this.output.play();
      },
    });
    for (const event of audioEventTypes) {
      this.driver.on(event, (originalEvent) => this.forward(event, originalEvent));
    }
    this.output.setSource(this.driver.element);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.deviceChange);
  }

  get capabilities(): EngineCapabilities {
    const next: EngineCapabilities = {
      supportsRate: true,
      supportsSinkId: this.supportsSinkId,
      supportsEqualizer: this.driver.processingAvailable,
      supportsSpectrum: this.driver.processingAvailable,
      supportsFade: this.driver.processingAvailable,
    };
    const previous = this.capabilitySnapshot;
    if (
      !previous ||
      previous.supportsSinkId !== next.supportsSinkId ||
      previous.supportsEqualizer !== next.supportsEqualizer ||
      previous.supportsSpectrum !== next.supportsSpectrum ||
      previous.supportsFade !== next.supportsFade
    ) {
      this.capabilitySnapshot = next;
      return next;
    }
    return previous;
  }

  get state(): PlaybackState {
    if (this.destroyed) return "idle";
    if (this.error) return "error";
    if (this.loading) return "loading";
    if (!this.src) return "idle";
    if (this.driver.element.ended) return "ended";
    if (this.readyState === 0) return "loading";
    if (this.paused) return "paused";
    return this.buffering ? "buffering" : "playing";
  }

  get sessionId(): number {
    return this.driver.loadGeneration;
  }

  get currentTime(): number {
    return this.driver.element.currentTime || 0;
  }

  get duration(): number {
    return Number.isFinite(this.driver.element.duration) ? this.driver.element.duration : 0;
  }

  get paused(): boolean {
    return this.driver.element.paused;
  }

  get src(): string {
    return this.driver.source;
  }

  get readyState(): number {
    return this.driver.element.readyState;
  }

  get error(): PlaybackError | undefined {
    if (this.deviceError) return this.deviceError;
    const code = this.driver.errorCode;
    if (!code) return undefined;
    return {
      kind: code === 2 ? "network" : code === 3 ? "decode" : "source",
      message: this.driver.element.error?.message ?? "",
      mediaErrorCode: code,
    };
  }

  private get supportsSinkId(): boolean {
    const context: (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined =
      this.driver.context;
    return (
      typeof this.driver.element.setSinkId === "function" ||
      typeof context?.setSinkId === "function" ||
      (typeof AudioContext !== "undefined" &&
        "setSinkId" in AudioContext.prototype &&
        typeof AudioContext.prototype.setSinkId === "function")
    );
  }

  async init(): Promise<void> {
    this.ensureUsable();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.deviceChange);
    this.destroyed = true;
    ++this.revision;
    this.cancelFade();
    this.output.setSource(null);
    this.driver.dispose();
    this.listeners.clear();
  }

  async play(url?: string, options: PlayOptions = {}): Promise<void> {
    this.ensureUsable();
    if (this.deviceError) throw new Error(this.deviceError.message);
    this.cancelFade();
    const revision = ++this.revision;
    if (url !== undefined) {
      this.loading = true;
      this.buffering = false;
      const loading = this.driver.load(url, options.source);
      const generation = this.sessionId;
      const intent = this.driver.playIntentGeneration;
      await loading;
      if (!this.driver.isCurrent(generation)) return;
      this.loading = false;
      this.syncOutput();
      if (revision !== this.revision || intent !== this.driver.playIntentGeneration) return;
    }
    if (revision !== this.revision || this.destroyed) return;
    if (options.seek !== undefined) this.driver.seek(options.seek);
    if (revision !== this.revision) return;
    this.syncGains(options.autoPlay !== false && options.fadeIn, options.fadeDuration);
    if (options.autoPlay === false) return;
    try {
      await this.driver.play();
    } catch (error) {
      if (revision === this.revision) this.output.pause();
      throw error;
    }
  }

  async pause(options: PauseOptions = {}): Promise<void> {
    this.ensureUsable();
    this.cancelFade();
    const revision = ++this.revision;
    // 即使保留正在发声的渐出，也要立即撤销加载完成后的自动播放与图谱恢复。
    this.driver.cancelPendingPlay();
    const graph = this.driver.gain;
    const context = this.driver.context;
    if (!options.fadeOut || this.paused || !graph || !context) {
      this.output.pause();
      this.driver.pause();
      return;
    }
    const duration = Math.max(0, options.fadeDuration ?? 1);
    const now = context.currentTime;
    graph.gain.cancelScheduledValues(now);
    graph.gain.setValueAtTime(graph.gain.value, now);
    graph.gain.linearRampToValueAtTime(0, now + duration);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.fade = undefined;
        if (revision === this.revision) {
          this.output.pause();
          this.driver.pause();
        }
        resolve();
      }, duration * 1000);
      this.fade = { timer, resolve };
    });
  }

  async stop(): Promise<void> {
    this.ensureUsable();
    ++this.revision;
    this.cancelFade();
    this.output.pause();
    this.driver.pause();
    this.driver.seek(0);
  }

  async clearSource(): Promise<void> {
    this.ensureUsable();
    ++this.revision;
    this.cancelFade();
    this.loading = false;
    this.buffering = false;
    this.output.setSource(null);
    this.driver.clearSource();
    this.syncOutput();
  }

  async seek(seconds: number): Promise<void> {
    this.ensureUsable();
    this.driver.seek(seconds);
  }

  async setVolume(value: number): Promise<void> {
    this.ensureUsable();
    this.volume = Math.max(0, Math.min(1, value));
    this.driver.setVolume(this.volume);
  }

  getVolume(): number {
    return this.volume;
  }

  async setRate(rate: number): Promise<void> {
    this.ensureUsable();
    this.driver.setRate(rate);
  }

  getRate(): number {
    return this.driver.element.playbackRate || 1;
  }

  async getOutputDevices(): Promise<readonly AudioOutputDevice[]> {
    this.ensureUsable();
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audiooutput")
      .map((device) => ({
        id: device.deviceId || "default",
        label: device.label || "",
        available: true,
      }));
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.ensureUsable();
    this.selectedSink = deviceId;
    await this.output.setSinkId(deviceId);
    if (this.selectedSink === deviceId) this.deviceError = undefined;
  }

  onEvent(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setFilterGain(index: number, value: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.desiredGains.length ||
      !Number.isFinite(value)
    )
      return;
    this.desiredGains[index] = Math.max(-40, Math.min(40, value));
    const filter = this.driver.filters[index];
    if (filter) filter.gain.value = this.desiredGains[index];
  }

  getFilterGains(): readonly number[] {
    return [...this.desiredGains];
  }

  getFrequencyData(): Uint8Array {
    const analyser = this.driver.analyser;
    if (!analyser) return new Uint8Array(0);
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    return data;
  }

  private forward(event: AudioDriverEvent, originalEvent: Event): void {
    if (this.destroyed) return;
    if (event === "waiting" || event === "stalled") {
      this.buffering = event !== "stalled" || this.readyState < 3;
    } else if (event === "playing" || event === "canplay" || event === "loadstart") {
      this.buffering = false;
    }
    if (event === "loadstart") this.loading = false;
    const generation = this.sessionId;
    const element = this.driver.element;
    if (event === "processingchange") {
      this.syncGains();
      this.syncOutput();
      this.emit("capabilitieschange");
    }
    if (!this.driver.isCurrent(generation) || element !== this.driver.element) return;
    this.emit(event, originalEvent);
    if (!this.driver.isCurrent(generation) || element !== this.driver.element) return;
    if (
      event === "play" ||
      event === "playing" ||
      event === "pause" ||
      event === "ended" ||
      event === "error" ||
      event === "waiting" ||
      event === "stalled" ||
      event === "canplay" ||
      event === "loadstart"
    ) {
      this.emit("statechange");
    }
  }

  private emit(type: PlaybackEventType, originalEvent?: Event): void {
    const event: PlaybackEvent = {
      type,
      sessionId: this.sessionId,
      originalEvent,
      ...(type === "error" ? { error: this.error } : {}),
    };
    const element = this.driver.element;
    for (const listener of [...this.listeners]) {
      if (
        !this.driver.isCurrent(event.sessionId) ||
        element !== this.driver.element ||
        this.destroyed
      )
        break;
      listener(event);
    }
  }

  private syncOutput(): void {
    this.output.setSource(this.driver.element, this.driver.context, this.driver.gain);
    void this.output.refresh().catch((error: unknown) => {
      console.error("AudioManager: 设置输出设备失败", error);
    });
  }

  private syncGains(fadeIn = false, fadeDuration = 1): void {
    const graph = this.driver.gain;
    const context = this.driver.context;
    if (!graph || !context) return;
    const now = context.currentTime;
    graph.gain.cancelScheduledValues(now);
    graph.gain.setValueAtTime(fadeIn ? 0 : this.volume, now);
    if (fadeIn) graph.gain.linearRampToValueAtTime(this.volume, now + Math.max(0, fadeDuration));
    this.desiredGains.forEach((gain, index) => {
      const filter = this.driver.filters[index];
      if (filter) filter.gain.value = gain;
    });
  }

  private cancelFade(): void {
    const fade = this.fade;
    this.fade = undefined;
    if (!fade) return;
    clearTimeout(fade.timer);
    fade.resolve();
  }

  private ensureUsable(): void {
    if (this.destroyed) throw new Error("Browser playback engine is destroyed");
  }
}
