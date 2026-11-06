import type { MpvEvent, MpvLoadRequest, MpvOutputDevice, MpvSnapshot } from "./mygo.bindings";

export type {
  MpvEvent,
  MpvFailure,
  MpvLoadRequest,
  MpvOutputDevice,
  MpvSnapshot,
} from "./mygo.bindings";

// provider 保留 Go 的生命周期/音源代次；上层引擎据此维护同步快照和歌词时钟。
export interface MpvPlaybackCommands {
  initialize(): Promise<MpvSnapshot>;
  load(lifecycle: number, request: MpvLoadRequest): Promise<MpvSnapshot>;
  play(lifecycle: number, session: number): Promise<void>;
  pause(lifecycle: number, session: number): Promise<void>;
  stop(lifecycle: number, session: number): Promise<MpvSnapshot>;
  clearSource(lifecycle: number, session: number): Promise<MpvSnapshot>;
  seek(lifecycle: number, session: number, seconds: number): Promise<void>;
  setVolume(lifecycle: number, session: number, volume: number): Promise<void>;
  setRate(lifecycle: number, session: number, rate: number): Promise<void>;
  getOutputDevices(lifecycle: number): Promise<MpvOutputDevice[]>;
  setOutputDevice(lifecycle: number, device: string): Promise<void>;
  snapshot(lifecycle: number): Promise<MpvSnapshot>;
  destroy(lifecycle: number): Promise<void>;
}

export interface PlatformMpvPlayback extends MpvPlaybackCommands {
  readonly capabilities: {
    readonly supportsRate: true;
    readonly supportsSinkId: true;
    readonly supportsEqualizer: false;
    readonly supportsSpectrum: false;
    readonly supportsFade: false;
  };
  onEvent(listener: (event: MpvEvent) => void): () => void;
  // shell 撤销时先清订阅，Go 生命周期服务负责停止实例及释放读者。
  teardown(): void;
}

export function createMpvPlaybackProvider(
  commands: MpvPlaybackCommands,
  subscribe: (listener: (event: MpvEvent) => void) => () => void,
): PlatformMpvPlayback {
  const subscriptions = new Set<() => void>();
  return {
    ...commands,
    capabilities: {
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: false,
      supportsSpectrum: false,
      supportsFade: false,
    },
    onEvent(listener) {
      let active = true;
      let last: MpvSnapshot | undefined;
      const release = subscribe((event) => {
        if (!active) return;
        const next = event.snapshot;
        if (
          last &&
          (next.lifecycle < last.lifecycle ||
            (next.lifecycle === last.lifecycle &&
              (next.session < last.session ||
                (next.session === last.session && next.sequence <= last.sequence))))
        ) {
          return;
        }
        last = next;
        listener(event);
      });
      const off = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(off);
        release();
      };
      subscriptions.add(off);
      return off;
    },
    teardown() {
      for (const off of subscriptions) off();
    },
  };
}
