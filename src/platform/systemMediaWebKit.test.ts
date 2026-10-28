import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebKitSystemMedia } from "./systemMediaWebKit";
import type { PlatformSystemMedia } from "./systemMedia";
import type { SystemMediaTrack } from "./mygo.bindings";

const track: SystemMediaTrack = {
  id: "synthetic:a",
  source: "online",
  title: "Synthetic title",
  artist: "Synthetic artist",
  album: "Synthetic album",
  state: "playing",
  rate: 1.75,
  durationMs: 10000,
  positionMs: 2000,
  canPrevious: true,
  canNext: true,
};

function fixture() {
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
    setArtwork: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: vi.fn(() => () => {}),
  };
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  const web = {
    metadata: null as MediaMetadataInit | null,
    playbackState: "none",
    setPositionState: vi.fn(),
    setActionHandler: vi.fn(
      (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        if (handler) handlers.set(action, handler);
        else handlers.delete(action);
      },
    ),
  };
  class Metadata {
    constructor(value: MediaMetadataInit) {
      Object.assign(this, value);
    }
  }
  vi.stubGlobal("navigator", { mediaSession: web });
  vi.stubGlobal("window", { MediaMetadata: Metadata });
  const provider = createWebKitSystemMedia(native);
  return { native, handlers, web, provider };
}

afterEach(() => vi.unstubAllGlobals());

describe("WebKit system media ownership", () => {
  it("retains native generation and power while publishing metadata, artwork and rate only to WebKit", async () => {
    const f = fixture();
    expect(await f.provider.configure(0, true, true)).toEqual({
      generation: 1,
      mediaEnabled: true,
      metadataRequested: false,
      keepAwakeRequested: true,
    });
    expect(f.native.configure).toHaveBeenCalledWith(0, false, true);
    await f.provider.set(1, 1, track);
    expect(f.web.metadata).toMatchObject({ title: track.title, artist: track.artist });
    expect(f.web.playbackState).toBe("playing");
    expect(f.web.setPositionState).toHaveBeenLastCalledWith({
      duration: 10,
      position: 2,
      playbackRate: 1.75,
    });
    await f.provider.setArtwork!(1, 1, track.id, "iVBORsynthetic");
    expect(f.web.metadata?.artwork).toEqual([{ src: "data:image/png;base64,iVBORsynthetic" }]);
    await f.provider.setPlayback(1, 1, track.id, "paused", 0);
    expect(f.web.playbackState).toBe("paused");
    expect(f.web.setPositionState).toHaveBeenLastCalledWith({
      duration: 10,
      position: 0,
      playbackRate: 1.75,
    });
    for (const method of ["set", "setPlayback", "setArtwork", "clear", "onCommand"] as const)
      expect(f.native[method]).not.toHaveBeenCalled();
    await f.provider.teardown(1);
    expect(f.native.teardown).toHaveBeenCalledWith(1);
    expect(f.handlers.size).toBe(0);
    expect(f.web.metadata).toBeNull();
  });

  it("routes all actions including seek zero and rejects late handlers and stale snapshots", async () => {
    const f = fixture();
    const command = vi.fn();
    f.provider.onCommand(command);
    await f.provider.configure(0, true, false);
    await f.provider.set(1, 1, track);
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto"] as const)
      f.handlers.get(action)!({ action, seekTime: 0 });
    expect(command.mock.calls.map(([value]) => value.action)).toEqual([
      "play",
      "pause",
      "previous",
      "next",
      "seek",
    ]);
    expect(command).toHaveBeenLastCalledWith({
      generation: 1,
      revision: 1,
      trackId: track.id,
      action: "seek",
      positionMs: 0,
    });
    const late = f.handlers.get("nexttrack")!;
    f.handlers.get("seekto")!({ action: "seekto", seekTime: 11 });
    expect(command).toHaveBeenCalledTimes(5);
    await f.provider.clear(1, 2);
    late({ action: "nexttrack" });
    expect(command).toHaveBeenCalledTimes(5);
    expect(f.handlers.size).toBe(0);
    await expect(f.provider.setArtwork!(1, 1, track.id, "")).rejects.toThrow("no longer active");
    await f.provider.configure(1, true, true);
    await expect(f.provider.set(1, 3, track)).rejects.toThrow("no longer active");
    await f.provider.set(2, 1, { ...track, canNext: false, canPrevious: false, durationMs: 0 });
    expect([...f.handlers.keys()]).toEqual(["play", "pause"]);
    const paused = f.handlers.get("play")!;
    await f.provider.configure(2, false, true);
    paused({ action: "play" });
    expect(command).toHaveBeenCalledTimes(5);
    expect(f.handlers.size).toBe(0);
    expect(f.native.configure).toHaveBeenLastCalledWith(2, false, true);
  });

  it("never clears or controls a newer shell's session when the previous owner tears down", async () => {
    const f = fixture();
    const oldCommand = vi.fn();
    f.provider.onCommand(oldCommand);
    await f.provider.configure(0, true, false);
    await f.provider.set(1, 1, track);
    const late = f.handlers.get("play")!;
    const next = createWebKitSystemMedia(f.native);
    await next.configure(0, true, false);
    await next.set(2, 1, {
      ...track,
      title: "New owner",
      canPrevious: false,
      canNext: false,
      durationMs: 0,
    });
    await f.provider.teardown(1);
    late({ action: "play" });
    expect(oldCommand).not.toHaveBeenCalled();
    expect(f.web.metadata?.title).toBe("New owner");
    expect([...f.handlers.keys()]).toEqual(["play", "pause"]);
    await next.teardown(2);
  });

  it("reports unavailable Web APIs honestly while keeping power independently configured", async () => {
    const f = fixture();
    vi.stubGlobal("navigator", {});
    expect(await f.provider.configure(0, true, true)).toMatchObject({
      generation: 1,
      mediaEnabled: false,
      keepAwakeRequested: true,
    });
    await expect(f.provider.set(1, 1, track)).rejects.toThrow("no longer active");
    await f.provider.teardown(1);
    expect(f.native.configure).toHaveBeenCalledWith(0, false, true);
    expect(f.native.teardown).toHaveBeenCalledWith(1);
  });
  it("releases native power even if individual WebKit cleanup calls throw", async () => {
    const f = fixture();
    const command = vi.fn();
    f.provider.onCommand(command);
    await f.provider.configure(0, true, true);
    await f.provider.set(1, 1, track);
    const late = f.handlers.get("play")!;
    f.web.setActionHandler.mockImplementation(() => {
      throw new Error("synthetic handler cleanup failure");
    });
    f.web.setPositionState.mockImplementation(() => {
      throw new Error("synthetic position cleanup failure");
    });
    Object.defineProperty(f.web, "metadata", {
      configurable: true,
      set: () => {
        throw new Error("synthetic metadata cleanup failure");
      },
    });
    await expect(f.provider.teardown(1)).resolves.toBeUndefined();
    expect(f.native.teardown).toHaveBeenCalledExactlyOnceWith(1);
    late({ action: "play" });
    expect(command).not.toHaveBeenCalled();
  });
});
