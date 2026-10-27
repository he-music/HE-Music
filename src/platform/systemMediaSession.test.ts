import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { SystemMediaSession } from "./systemMediaSession";
import type { PlatformSystemMedia } from "./systemMedia";
import type { SystemMediaCommand, SystemMediaTrack } from "./mygo.bindings";

const cleanups: Array<() => Promise<void>> = [];
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await nextTick();
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const state = reactive({ media: true, power: false, playing: false, position: 0, clock: 0 });
  const track = reactive<SystemMediaTrack>({
    id: "fixture:a",
    source: "online",
    title: "Synthetic A",
    artist: "Synthetic Artist",
    album: "Synthetic Album",
    durationMs: 10000,
    positionMs: 0,
    state: "paused",
    rate: 1,
    canPrevious: true,
    canNext: true,
  });
  let generation = 0;
  const events = new Set<(command: SystemMediaCommand) => void>();
  const seeks = new Set<() => void>();
  const order: string[] = [];
  const provider: PlatformSystemMedia = {
    configure: vi.fn(async (_generation, mediaEnabled, preventSleep) => {
      order.push("configure");
      return {
        generation: ++generation,
        mediaEnabled,
        metadataRequested: false,
        keepAwakeRequested: preventSleep,
      };
    }),
    set: vi.fn(async () => {}),
    setPlayback: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {
      order.push("teardown");
    }),
    onCommand: (listener) => {
      order.push("subscribe");
      events.add(listener);
      return () => {
        order.push("off");
        events.delete(listener);
      };
    },
  };
  const execute = vi.fn();
  const failure = vi.fn();
  const session = new SystemMediaSession(
    provider,
    {
      settings: () => ({ media: state.media, preventSleep: state.power }),
      metadata: () =>
        track.id
          ? {
              id: track.id,
              source: track.source,
              title: track.title,
              artist: track.artist,
              album: track.album,
              durationMs: track.durationMs,
              rate: track.rate,
              canPrevious: track.canPrevious,
              canNext: track.canNext,
            }
          : null,
      trackID: () => track.id || null,
      state: () => (state.playing ? "playing" : "paused"),
      playback: () => ({ state: state.playing ? "playing" : "paused", positionMs: state.position }),
      onSeek: (listener) => {
        seeks.add(listener);
        return () => {
          seeks.delete(listener);
        };
      },
      execute,
    },
    failure,
  );
  cleanups.push(() => session.dispose());
  const emit = (patch: Partial<SystemMediaCommand> = {}) => {
    const command = {
      generation,
      revision: 1,
      trackId: track.id,
      action: "play",
      positionMs: 0,
      ...patch,
    };
    events.forEach((listener) => listener(command));
  };
  return { state, track, provider, execute, failure, session, emit, events, seeks, order };
}

describe("SystemMediaSession", () => {
  it("subscribes before claim; disabled media still configures the independent power preference", async () => {
    const f = fixture();
    f.state.media = false;
    f.state.power = true;
    await f.session.start();
    expect(f.order).toEqual(["subscribe", "configure"]);
    expect(f.provider.configure).toHaveBeenCalledWith(0, false, true);
    expect(f.provider.set).not.toHaveBeenCalled();
    f.state.media = true;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(1, true, true);
    expect(f.provider.set).toHaveBeenCalledOnce();
    f.state.media = false;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(2, false, true);
    f.state.power = false;
    await flush();
    expect(f.provider.configure).toHaveBeenLastCalledWith(3, false, false);
    await f.session.dispose();
    expect(f.order.slice(-2)).toEqual(["teardown", "off"]);
    expect(f.events.size).toBe(0);
    expect(f.seeks.size).toBe(0);
  });

  it("does not publish on progress/lyric clocks; actual state, seek0, metadata and rate update", async () => {
    const f = fixture();
    await f.session.start();
    await flush();
    const initialPlayback = vi.mocked(f.provider.setPlayback).mock.calls.length;
    for (let i = 0; i < 100; i++) {
      f.state.clock++;
      f.state.position++;
    }
    await flush();
    expect(f.provider.configure).toHaveBeenCalledOnce();
    expect(f.provider.set).toHaveBeenCalledOnce();
    expect(f.provider.setPlayback).toHaveBeenCalledTimes(initialPlayback);
    f.state.playing = true;
    await flush();
    expect(f.provider.setPlayback).toHaveBeenLastCalledWith(1, 1, f.track.id, "playing", 100);
    f.state.position = 0;
    f.seeks.forEach((seek) => seek());
    await flush();
    expect(f.provider.setPlayback).toHaveBeenLastCalledWith(1, 1, f.track.id, "playing", 0);
    f.track.rate = 1.5;
    await flush();
    expect(f.provider.set).toHaveBeenLastCalledWith(1, 2, expect.objectContaining({ rate: 1.5 }));
    f.track.title = "Updated title";
    await flush();
    expect(f.provider.set).toHaveBeenLastCalledWith(
      1,
      3,
      expect.objectContaining({ title: "Updated title" }),
    );
    expect(f.provider.configure).toHaveBeenCalledOnce();
  });

  it("rejects old generation/revision/track and queued actions after replacement or disposal", async () => {
    const f = fixture();
    await f.session.start();
    await flush();
    f.emit({ generation: 0 });
    f.emit({ revision: 0 });
    f.emit({ trackId: "old" });
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    f.emit({ action: "seek", positionMs: 0 });
    await flush();
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seek", positionMs: 0 }),
    );
    f.execute.mockClear();
    f.emit();
    f.track.id = "fixture:b";
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    f.emit({ revision: 2 });
    const cleanup = f.session.dispose();
    await cleanup;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledOnce();
  });

  it("clears an empty track and cannot resurrect a Set completed after disable/unmount", async () => {
    const f = fixture();
    f.track.id = "";
    await f.session.start();
    expect(f.provider.clear).toHaveBeenCalledWith(1, 1);
    let resolveSet = () => {};
    vi.mocked(f.provider.set).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve;
        }),
    );
    f.track.id = "fixture:a";
    await flush();
    f.state.media = false;
    const cleanup = f.session.dispose();
    resolveSet();
    await cleanup;
    f.emit({ revision: 2 });
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.setPlayback).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledWith(1);
  });

  it("reports native rejection, keeps queue usable, and tears down after an in-flight claim", async () => {
    const f = fixture();
    vi.mocked(f.provider.set).mockRejectedValueOnce(new Error("synthetic native rejection"));
    await f.session.start();
    expect(f.failure).toHaveBeenCalledOnce();
    f.track.title = "Retry on necessary change";
    await flush();
    expect(f.provider.set).toHaveBeenCalledTimes(2);
    await f.session.dispose();
    expect(f.provider.teardown).toHaveBeenCalledWith(1);
    const g = fixture();
    let finishClaim = () => {};
    vi.mocked(g.provider.configure).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClaim = () =>
            resolve({
              generation: 9,
              mediaEnabled: true,
              metadataRequested: false,
              keepAwakeRequested: true,
            });
        }),
    );
    void g.session.start();
    await flush();
    const cleanup = g.session.dispose();
    finishClaim();
    await cleanup;
    expect(g.provider.set).not.toHaveBeenCalled();
    expect(g.provider.teardown).toHaveBeenCalledWith(9);
  });
});
