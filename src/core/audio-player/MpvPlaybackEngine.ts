import type { PlatformMpvPlayback, MpvSnapshot, MpvEvent } from "@/platform/mpvPlayback";
import { MpvPlaybackClock } from "./MpvPlaybackClock";
import {
  audioEventTypes,
  type IPlaybackEngine,
  type PlaybackEvent,
  type PlaybackError,
  type PlayOptions,
} from "./IPlaybackEngine";

/** 单一原生实例；源命令串行发送，播放意图独立于异步源所有权。 */
export class MpvPlaybackEngine implements IPlaybackEngine {
  readonly id = "mpv";
  readonly capabilities = {
    supportsRate: true,
    supportsSinkId: true,
    supportsEqualizer: false,
    supportsSpectrum: false,
    supportsFade: false,
  };
  private snapshot?: MpvSnapshot;
  // 命令快照可先于原生事件返回；业务通知单独去重，不能被状态校正吞掉。
  private readonly eventSequences = new Map<MpvEvent["type"], number>();
  private readonly clock = new MpvPlaybackClock();
  private readonly listeners = new Set<(event: PlaybackEvent) => void>();
  private unsubscribe?: () => void;
  private initializing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private intent = false;
  private loading = false;
  private intentRevision = 0;
  private loadingSession = 0;
  private activeLoadRevision = 0;
  private source = "";
  private volume = 1;
  private rate = 1;
  private failure?: PlaybackError;
  private destroyed = false;

  constructor(private readonly provider: PlatformMpvPlayback) {}
  get sessionId() {
    return this.snapshot?.session ?? 0;
  }
  get state() {
    return this.failure ? ("error" as const) : (this.snapshot?.state ?? "idle");
  }
  get currentTime() {
    return this.clock.currentTime;
  }
  get duration() {
    return this.snapshot?.duration ?? 0;
  }
  get paused() {
    return !this.intent || !["playing", "buffering"].includes(this.state);
  }
  get src() {
    return this.source;
  }
  get error() {
    return this.failure;
  }

  init(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("mpv engine destroyed"));
    if (this.snapshot) return Promise.resolve();
    return (this.initializing ??= (async () => {
      this.unsubscribe = this.provider.onEvent((event) => this.receive(event));
      try {
        this.accept(await this.provider.initialize());
      } catch (error) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        throw error;
      } finally {
        this.initializing = undefined;
      }
    })());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    ++this.revision;
    this.intent = false;
    this.unsubscribe?.();
    await this.enqueue(async () => {
      if (this.initializing) await this.initializing;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.snapshot) await this.provider.destroy(this.snapshot.lifecycle);
      this.snapshot = undefined;
      this.source = "";
      this.clock.update({ position: 0, duration: 0, rate: this.rate, state: "idle" });
    });
    this.listeners.clear();
  }

  async play(url?: string, options: PlayOptions = {}): Promise<void> {
    const intentRevision = ++this.intentRevision;
    this.intent = options.autoPlay !== false;
    if (!url) {
      if (this.loading) return;
      return this.enqueue(async () => {
        if (this.snapshot && this.intent && this.source)
          await this.provider.play(this.snapshot.lifecycle, this.sessionId);
      });
    }
    const revision = ++this.revision;
    this.loading = true;
    this.loadingSession = this.sessionId;
    this.source = options.source?.identity ?? url;
    this.failure = undefined;
    await this.enqueue(async () => {
      await this.init();
      if (revision !== this.revision || !this.snapshot) return;
      this.activeLoadRevision = revision;
      this.loadingSession = this.sessionId;
      const loaded = await this.provider.load(this.snapshot.lifecycle, {
        url,
        format: options.source?.format ?? "",
        fileEpoch: options.source?.fileEpoch ?? 0,
        localRef: options.source?.localRef ?? null,
        autoPlay: false,
        start: options.seek ?? 0,
      });
      this.accept(loaded);
      if (revision !== this.revision) return;
      await this.provider.setVolume(loaded.lifecycle, loaded.session, this.volume);
      await this.provider.setRate(loaded.lifecycle, loaded.session, this.rate);
      if (revision !== this.revision) return;
      this.loading = false;
      if (this.intent && (this.intentRevision !== intentRevision || options.autoPlay !== false))
        await this.provider.play(loaded.lifecycle, loaded.session);
    }).finally(() => {
      if (revision === this.revision) this.loading = false;
    });
  }

  async pause(): Promise<void> {
    ++this.intentRevision;
    this.intent = false;
    this.freeze();
    await this.enqueue(async () => {
      if (this.snapshot) await this.provider.pause(this.snapshot.lifecycle, this.sessionId);
    });
  }

  stop(): Promise<void> {
    return this.clearSource();
  }
  async clearSource(): Promise<void> {
    ++this.revision;
    this.intent = false;
    this.loading = false;
    this.source = "";
    this.freeze();
    await this.enqueue(async () => {
      if (this.snapshot)
        this.accept(await this.provider.clearSource(this.snapshot.lifecycle, this.sessionId));
    });
  }
  async seek(seconds: number): Promise<void> {
    await this.enqueue(async () => {
      if (!this.snapshot) return;
      await this.provider.seek(this.snapshot.lifecycle, this.sessionId, seconds);
      this.accept(await this.provider.snapshot(this.snapshot.lifecycle));
    });
  }
  async setVolume(value: number): Promise<void> {
    this.volume = Math.max(0, Math.min(1, value));
    await this.enqueue(async () => {
      if (this.snapshot)
        await this.provider.setVolume(this.snapshot.lifecycle, this.sessionId, this.volume);
    });
  }
  getVolume() {
    return this.volume;
  }
  async setRate(value: number): Promise<void> {
    this.rate = value;
    await this.enqueue(async () => {
      if (!this.snapshot) return;
      await this.provider.setRate(this.snapshot.lifecycle, this.sessionId, value);
      this.accept(await this.provider.snapshot(this.snapshot.lifecycle));
    });
  }
  getRate() {
    return this.rate;
  }
  async getOutputDevices() {
    await this.init();
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error("mpv unavailable");
    return this.provider.getOutputDevices(snapshot.lifecycle);
  }
  async setSinkId(device: string): Promise<void> {
    const selected = device && device !== "default" ? device : "auto";
    await this.enqueue(async () => {
      await this.init();
      const snapshot = this.snapshot;
      if (!snapshot) throw new Error("mpv unavailable");
      if (selected !== "auto") {
        const devices = await this.provider.getOutputDevices(snapshot.lifecycle);
        if (!devices.some((item) => item.id === selected && item.available)) {
          this.intent = false;
          this.freeze();
          await this.provider.pause(snapshot.lifecycle, snapshot.session);
          throw new Error("Selected audio output is unavailable");
        }
      }
      await this.provider.setOutputDevice(snapshot.lifecycle, selected);
    });
  }
  onEvent(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private freeze(): void {
    this.clock.update({
      position: this.currentTime,
      duration: this.duration,
      rate: this.rate,
      state: "paused",
    });
  }
  private accept(next: MpvSnapshot): boolean {
    const previous = this.snapshot;
    if (
      previous &&
      (next.lifecycle !== previous.lifecycle ||
        next.session < previous.session ||
        next.sequence <= previous.sequence)
    )
      return false;
    if (next.session !== previous?.session) this.eventSequences.clear();
    this.snapshot = next;
    this.failure = this.playbackError(next);
    this.clock.update({ ...next, state: this.intent ? next.state : "paused" });
    return true;
  }
  private playbackError(snapshot: MpvSnapshot): PlaybackError | undefined {
    const error = snapshot.error;
    if (!error) return undefined;
    const kind =
      error.kind === "library" || error.kind === "abi" || error.kind === "symbol"
        ? "engine"
        : error.kind;
    return { kind, message: error.message };
  }
  private receive(event: MpvEvent): void {
    if (
      !this.snapshot ||
      event.snapshot.lifecycle !== this.snapshot.lifecycle ||
      event.snapshot.session < this.snapshot.session ||
      (this.loading &&
        (this.activeLoadRevision !== this.revision ||
          event.snapshot.session <= this.loadingSession) &&
        event.type !== "deviceschange")
    )
      return;
    const previousState = this.state;
    const updated = this.accept(event.snapshot);
    if (event.snapshot.session !== this.sessionId) return;
    const terminal = event.type === "ended" || event.type === "error";
    if (!updated && !terminal) return;
    if (event.snapshot.sequence <= (this.eventSequences.get(event.type) ?? 0)) return;
    this.eventSequences.set(event.type, event.snapshot.sequence);
    if (!this.source && event.type !== "deviceschange") return;
    if (event.type === "ended" && this.loading) return;
    if (event.type === "error" && event.snapshot.error?.kind === "device") this.intent = false;
    if (this.state === "buffering" && previousState !== "buffering" && event.type !== "waiting")
      this.emitEvent("waiting");
    if (this.state === "playing" && previousState === "buffering" && event.type !== "playing")
      this.emitEvent("playing");
    const type =
      audioEventTypes.find((type) => type === event.type) ??
      (event.type === "deviceschange" || event.type === "statechange" ? event.type : undefined);
    if (type)
      this.emitEvent(
        type,
        event.type === "error" ? this.playbackError(event.snapshot) : this.failure,
      );
  }
  private emitEvent(type: PlaybackEvent["type"], error = this.failure): void {
    if (!this.source && type !== "deviceschange") return;
    const revision = this.revision;
    const sessionId = this.sessionId;
    for (const listener of [...this.listeners]) {
      if (revision !== this.revision || sessionId !== this.sessionId) break;
      listener({ type, sessionId, error });
    }
  }
}
