import { computed, shallowRef, watch } from "vue";
import type {
  LyricsClock,
  LyricsCommand,
  LyricsSnapshot,
  LyricsWindowState,
  PlatformDesktopLyrics,
} from "./desktopLyrics";

export type DesktopLyricsSnapshot = Omit<LyricsSnapshot, "epoch" | "seq">;
export type DesktopLyricsClock = Omit<LyricsClock, "epoch" | "seq">;
export interface DesktopLyricsSource {
  trackKey(): string;
  snapshotDependencies(): readonly unknown[];
  clockDependencies(): readonly unknown[];
  snapshot(): DesktopLyricsSnapshot;
  clock(): DesktopLyricsClock;
  onSeek(listener: () => void): () => void;
  execute(command: LyricsCommand): void | Promise<void>;
}

const currentSession = shallowRef<DesktopLyricsSession>();
/** The Ready main shell owns this reference; child views use the provider directly. */
export const desktopLyricsSession = computed(() => currentSession.value);

export class DesktopLyricsSession {
  private readonly readyState = shallowRef(false);
  private readonly windowState = shallowRef<LyricsWindowState>();
  private readonly errorState = shallowRef<unknown>();
  readonly ready = computed(() => this.readyState.value);
  readonly window = computed(() => this.windowState.value);
  readonly failure = computed(() => this.errorState.value);
  readonly epoch = computed(() => (this.readyState.value ? this.nativeEpoch : undefined));
  get canResetPosition(): boolean {
    return typeof this.provider.resetPosition === "function";
  }
  private nativeEpoch: number | undefined;
  private disposed = false;
  private started = false;
  private seq = 0;
  private acceptedTrack: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private beginning: Promise<void> | undefined;
  private cleanup: Promise<void> | undefined;
  private stops: Array<() => void> = [];
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly provider: PlatformDesktopLyrics,
    private readonly source: DesktopLyricsSource,
  ) {}

  start(): Promise<void> {
    if (this.started || this.disposed) return this.beginning ?? Promise.resolve();
    this.started = true;
    this.beginning = this.initialize();
    return this.beginning;
  }

  private async initialize(): Promise<void> {
    try {
      this.stops.push(this.provider.onWindow((state) => this.acceptWindow(state)));
      this.stops.push(
        this.provider.onCommand((command) => {
          if (!this.acceptsCommand(command)) return;
          void Promise.resolve()
            .then(async () => {
              if (this.acceptsCommand(command)) await this.source.execute(command);
            })
            .catch((error: unknown) => this.recordFailure(error));
        }),
      );
      const { epoch } = await this.provider.begin();
      if (this.disposed) {
        await this.provider.teardown(epoch);
        return;
      }
      this.nativeEpoch = epoch;
      this.readyState.value = true;
      currentSession.value = this;
      this.stops.push(
        watch(
          () => this.source.snapshotDependencies(),
          () => void this.publishSnapshot().catch(() => {}),
        ),
      );
      this.stops.push(
        watch(
          () => this.source.clockDependencies(),
          () => void this.publishClock().catch(() => {}),
        ),
      );
      this.stops.push(this.source.onSeek(() => void this.publishClock().catch(() => {})));
      await this.publishSnapshot();
      if (!this.disposed) this.acceptWindow(await this.provider.getState(epoch));
    } catch (error) {
      this.recordFailure(error);
      this.readyState.value = false;
      if (currentSession.value === this) currentSession.value = undefined;
      this.windowState.value = undefined;
      this.clearInterval();
      this.stopSubscriptions();
      const epoch = this.nativeEpoch;
      this.nativeEpoch = undefined;
      this.acceptedTrack = undefined;
      if (epoch !== undefined) await this.provider.teardown(epoch).catch(() => {});
    }
  }

  private stopSubscriptions(): void {
    for (const stop of this.stops.splice(0)) {
      try {
        stop();
      } catch (error) {
        this.recordFailure(error);
      }
    }
  }

  private recordFailure(error: unknown): void {
    if (!this.disposed) this.errorState.value = error;
  }

  private acceptsCommand(command: LyricsCommand): boolean {
    return (
      !this.disposed &&
      this.readyState.value &&
      command.epoch === this.nativeEpoch &&
      command.trackKey === this.source.trackKey() &&
      command.trackKey === this.acceptedTrack &&
      (command.trackKey !== "" ||
        command.action === "show-main" ||
        command.action === "open-settings")
    );
  }

  /** Merge native events and RPC responses using the same revision guard. */
  acceptWindow(state: LyricsWindowState): void {
    if (
      this.disposed ||
      state.epoch !== this.nativeEpoch ||
      state.revision <= (this.windowState.value?.revision ?? -1)
    )
      return;
    this.windowState.value = state;
    this.errorState.value = state.failure || undefined;
    if (state.visible && this.interval === undefined) {
      this.interval = setInterval(() => void this.publishClock().catch(() => {}), 250);
    } else if (!state.visible) {
      this.clearInterval();
    }
  }

  private clearInterval(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }

  private enqueue<T>(operation: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = this.nativeEpoch;
    const result = this.queue.then(async () => {
      if (
        this.disposed ||
        !this.readyState.value ||
        epoch === undefined ||
        epoch !== this.nativeEpoch
      ) {
        throw new Error("桌面歌词会话未就绪或已失效");
      }
      return operation(epoch);
    });
    this.queue = result.then(
      () => {},
      (error: unknown) => this.recordFailure(error),
    );
    return result;
  }

  private async sendSnapshot(epoch: number): Promise<void> {
    const snapshot = this.source.snapshot();
    this.acceptedTrack = undefined;
    await this.provider.publishSnapshot({ ...snapshot, epoch, seq: ++this.seq });
    if (
      !this.disposed &&
      epoch === this.nativeEpoch &&
      snapshot.trackKey === this.source.trackKey()
    ) {
      this.acceptedTrack = snapshot.trackKey;
    }
  }

  publishSnapshot(): Promise<void> {
    return this.enqueue((epoch) => this.sendSnapshot(epoch));
  }

  publishClock(): Promise<void> {
    return this.enqueue(async (epoch) => {
      const clock = this.source.clock();
      if (clock.trackKey !== this.acceptedTrack) return;
      await this.provider.publishClock({ ...clock, epoch, seq: ++this.seq });
    });
  }

  requestVisible(visible: boolean): Promise<LyricsWindowState> {
    return this.enqueue(async (epoch) => {
      if (visible) await this.sendSnapshot(epoch);
      if (this.disposed) throw new Error("桌面歌词会话已失效");
      const state = await this.provider.setVisible(epoch, visible);
      this.acceptWindow(state);
      return state;
    });
  }

  requestResetPosition(): Promise<LyricsWindowState> {
    const reset = this.provider.resetPosition;
    if (!reset) return Promise.reject(new Error("桌面歌词位置重置不可用"));
    return this.enqueue(async (epoch) => {
      const state = await reset(epoch);
      this.acceptWindow(state);
      return state;
    });
  }

  requestLocked(locked: boolean): Promise<LyricsWindowState> {
    return this.enqueue(async (epoch) => {
      const state = await this.provider.setLocked(epoch, locked);
      this.acceptWindow(state);
      return state;
    });
  }
  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.disposed = true;
    this.readyState.value = false;
    const epoch = this.nativeEpoch;
    this.nativeEpoch = undefined;
    this.acceptedTrack = undefined;
    if (currentSession.value === this) currentSession.value = undefined;
    this.clearInterval();
    this.stopSubscriptions();
    this.cleanup =
      epoch === undefined
        ? (this.beginning ?? Promise.resolve())
        : this.provider.teardown(epoch).catch(() => {});
    return this.cleanup;
  }
}
