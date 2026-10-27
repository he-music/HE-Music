import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { SystemMediaSession } from "./systemMediaSession";
import type { PlatformSystemMedia } from "./systemMedia";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAH0lEQVR4nAASAO3/AqoAAP8AAAAAAAAAAAAAAAAAAwAZcgGsUdag8AAAAABJRU5ErkJggg==";
const response = () => new Response(Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const cleanups: Array<() => Promise<void>> = [];
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://fixture.invalid/decoded");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 2;
      naturalHeight = 2;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    },
  );
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(withAPI = true) {
  const state = reactive({
    media: true,
    power: false,
    id: "a",
    cover: "/a.png",
    rate: 1,
    playing: false,
    position: 0,
    clock: 0,
  });
  const failure = vi.fn();
  const artwork = vi.fn<NonNullable<PlatformSystemMedia["setArtwork"]>>(async () => {});
  let generation = 0;
  const provider: PlatformSystemMedia = {
    configure: vi.fn(async (_generation, mediaEnabled, preventSleep) => ({
      generation: ++generation,
      mediaEnabled,
      keepAwakeRequested: preventSleep,
      metadataRequested: false,
    })),
    set: vi.fn(async () => {}),
    setPlayback: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: () => () => {},
    ...(withAPI ? { setArtwork: artwork } : {}),
  };
  let seek: () => void = () => {};
  const source = {
    settings: () => ({ media: state.media, preventSleep: state.power }),
    trackID: () => state.id || null,
    artwork: () => state.cover,
    metadata: () =>
      state.id
        ? {
            id: state.id,
            source: "online",
            title: state.id,
            artist: "Synthetic",
            album: "Fixture",
            durationMs: 10000,
            rate: state.rate,
            canPrevious: true,
            canNext: true,
          }
        : null,
    state: (): "playing" | "paused" => (state.playing ? "playing" : "paused"),
    playback: vi.fn(() => ({ state: source.state(), positionMs: state.position })),
    onSeek: (listener: () => void) => {
      seek = listener;
      return () => {
        seek = () => {};
      };
    },
    execute: vi.fn(),
  };
  const session = new SystemMediaSession(provider, source, failure);
  cleanups.push(() => session.dispose());
  return { state, source, provider, artwork, failure, session, seek: () => seek() };
}

describe("SystemMediaSession artwork integration with actual loader", () => {
  it("publishes metadata promptly; late A cannot attach to B, and images follow accepted identity", async () => {
    let completeA: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeA = resolve;
        }),
    );
    fetchMock.mockImplementation(() => Promise.resolve(response()));
    const f = fixture();
    await f.session.start();
    await flush();
    expect(f.provider.set).toHaveBeenCalledOnce();
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 1, "a", ""]);
    const firstSignal = fetchMock.mock.calls[0][1]?.signal;
    f.state.id = "b";
    f.state.cover = "/b.png";
    await flush();
    expect(firstSignal?.aborted).toBe(true);
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 2, "b", png]);
    const calls = f.artwork.mock.calls.length;
    completeA(response());
    await flush();
    expect(f.artwork).toHaveBeenCalledTimes(calls);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it("clears on same-track image replacement; a Rate revision reuses the completed image", async () => {
    fetchMock.mockResolvedValue(response());
    const f = fixture();
    await f.session.start();
    await flush();
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 1, "a", png]);
    f.state.rate = 2.5;
    f.state.playing = true;
    f.state.position = 700;
    f.seek();
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(f.provider.set).toHaveBeenLastCalledWith(
      1,
      2,
      expect.objectContaining({ rate: 2.5, state: "playing", positionMs: 700 }),
    );
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 2, "a", png]);
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.state.cover = "/replacement.png";
    await flush();
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 2, "a", ""]);
    f.state.rate = 3;
    await flush();
    finish(response());
    await flush();
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 3, "a", png]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const writes = f.artwork.mock.calls.length;
    const reads = f.source.playback.mock.calls.length;
    for (let i = 0; i < 200; i++) {
      f.state.position++;
      f.state.clock++;
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(f.artwork).toHaveBeenCalledTimes(writes);
    expect(f.source.playback).toHaveBeenCalledTimes(reads);
  });

  it.each(["disabled", "no-api", "empty", "missing-cover"])(
    "does not fetch for %s",
    async (condition) => {
      const f = fixture(condition !== "no-api");
      if (condition === "disabled") f.state.media = false;
      if (condition === "empty") f.state.id = "";
      if (condition === "missing-cover") f.state.cover = "";
      await f.session.start();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      if (condition === "no-api") expect(f.artwork).not.toHaveBeenCalled();
    },
  );

  it.each(["disable", "dispose"])("aborts %s and ignores a late image", async (operation) => {
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    await f.session.start();
    await flush();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    if (operation === "disable") f.state.media = false;
    else await f.session.dispose();
    await flush();
    expect(signal?.aborted).toBe(true);
    const writes = f.artwork.mock.calls.length;
    finish(response());
    await flush();
    expect(f.artwork).toHaveBeenCalledTimes(writes);
    if (operation === "dispose") expect(f.provider.teardown).toHaveBeenCalledOnce();
  });

  it("contains CORS/download and native artwork failures without blocking playback or future metadata", async () => {
    fetchMock.mockRejectedValue(new TypeError("Synthetic CORS failure"));
    const f = fixture();
    f.artwork.mockRejectedValue(new Error("Synthetic native rejection"));
    await f.session.start();
    await flush();
    f.state.playing = true;
    f.state.rate = 1.75;
    await flush();
    expect(f.provider.set).toHaveBeenLastCalledWith(1, 2, expect.objectContaining({ rate: 1.75 }));
    expect(f.provider.setPlayback).toHaveBeenLastCalledWith(1, 2, "a", "playing", 0);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it("does not attach while a replacement Set is pending, then uses its new revision", async () => {
    fetchMock.mockResolvedValue(response());
    const f = fixture();
    let accept: () => void = () => {};
    vi.mocked(f.provider.set).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const starting = f.session.start();
    await flush();
    expect(f.artwork).not.toHaveBeenCalled();
    f.state.rate = 2;
    accept();
    await starting;
    await flush();
    expect(f.artwork.mock.calls.at(-1)).toEqual([1, 2, "a", png]);
    expect(f.artwork.mock.calls.every((call) => call[1] === 2)).toBe(true);
  });
});
