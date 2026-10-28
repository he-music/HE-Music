import { afterEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { SystemMediaSession } from "./systemMediaSession";
import { createWebKitSystemMedia } from "./systemMediaWebKit";
import type { PlatformSystemMedia } from "./systemMedia";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function fixture(available: boolean) {
  let generation = 0;
  const native: PlatformSystemMedia = {
    configure: vi.fn(async (_generation, mediaEnabled, preventSleep) => ({
      generation: ++generation,
      mediaEnabled,
      metadataRequested: false,
      keepAwakeRequested: preventSleep,
    })),
    set: vi.fn(async () => {}),
    setPlayback: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: vi.fn(() => () => {}),
  };
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  const web = {
    metadata: null as MediaMetadataInit | null,
    playbackState: "none",
    setPositionState: vi.fn(),
    setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
  };
  class Metadata {
    constructor(value: MediaMetadataInit) {
      Object.assign(this, value);
    }
  }
  vi.stubGlobal("navigator", available ? { mediaSession: web } : {});
  vi.stubGlobal("window", { MediaMetadata: Metadata });
  const state = reactive({ media: true, power: true, rate: 1.5, playing: true, clock: 0 });
  const failure = vi.fn();
  const execute = vi.fn();
  const session = new SystemMediaSession(
    createWebKitSystemMedia(native),
    {
      settings: () => ({ media: state.media, preventSleep: state.power }),
      metadata: () => ({
        id: "synthetic:session",
        source: "online",
        title: "Synthetic session",
        artist: "Synthetic artist",
        album: "Synthetic album",
        durationMs: 10000,
        rate: state.rate,
        canNext: true,
        canPrevious: true,
      }),
      state: () => (state.playing ? "playing" : "paused"),
      playback: () => ({
        state: state.playing ? "playing" : "paused",
        positionMs: state.clock,
      }),
      trackID: () => "synthetic:session",
      onSeek: () => () => {},
      execute,
    },
    failure,
  );
  cleanups.push(() => session.dispose());
  return { native, web, handlers, state, session, failure, execute };
}

describe("SystemMediaSession with WebKit owner", () => {
  it("respects unavailable status without publishing while retaining and releasing native power", async () => {
    const f = fixture(false);
    await f.session.start();
    f.state.rate = 2;
    f.state.playing = false;
    await flush();
    expect(f.native.configure).toHaveBeenCalledWith(0, false, true);
    expect(f.native.set).not.toHaveBeenCalled();
    expect(f.native.setPlayback).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
    await f.session.dispose();
    expect(f.native.teardown).toHaveBeenCalledWith(1);
  });

  it("updates rate and state without clock-driven publication and drops actions after disable", async () => {
    const f = fixture(true);
    await f.session.start();
    await flush();
    const writes = f.web.setPositionState.mock.calls.length;
    for (let i = 0; i < 100; i++) f.state.clock++;
    await flush();
    expect(f.web.setPositionState).toHaveBeenCalledTimes(writes);
    f.state.rate = 2;
    await flush();
    expect(f.web.setPositionState).toHaveBeenLastCalledWith({
      duration: 10,
      position: 0.1,
      playbackRate: 2,
    });
    f.state.playing = false;
    await flush();
    expect(f.web.playbackState).toBe("paused");
    f.handlers.get("seekto")!({ action: "seekto", seekTime: 0 });
    await flush();
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seek", positionMs: 0 }),
    );
    const late = f.handlers.get("nexttrack")!;
    f.state.media = false;
    await flush();
    late({ action: "nexttrack" });
    await flush();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.native.configure).toHaveBeenLastCalledWith(1, false, true);
    expect(f.web.metadata).toBeNull();
    expect(f.failure).not.toHaveBeenCalled();
  });
});
