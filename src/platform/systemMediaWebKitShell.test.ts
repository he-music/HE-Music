import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PlatformAdapter } from "./types";
import type { PlatformSystemMedia } from "./systemMedia";

const mocks = vi.hoisted(() => ({
  platform: {} as PlatformAdapter,
  player: {
    getSeek: vi.fn(() => 0),
    onSeek: vi.fn(() => () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    nextOrPrev: vi.fn(),
    setSeek: vi.fn(),
  },
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/env", () => ({ isElectron: false }));
vi.mock("@/utils/format", () => ({ getSizeCover: (song: { cover: string }) => song.cover }));
vi.mock("@/utils/blob", () => ({ default: {} }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/utils/helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("./systemMediaArtwork", () => ({
  loadSystemMediaArtwork: vi.fn(async () => "iVBORsynthetic"),
}));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  ...(await import("@/stores/status")),
  ...(await import("@/stores/music")),
  useDataStore: () => ({ playList: [{}] }),
}));
vi.stubGlobal("localStorage", {});
const { useMusicStore, useSettingStore, useStatusStore } = await import("@/stores");
const { createShellSystemMediaSession } = await import("@/composables/shellSystemMedia");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

describe("shellSystemMedia macOS publisher selection", () => {
  it("uses WebKit for the actual shell metadata, artwork and controls, preserving native power", async () => {
    setActivePinia(createPinia());
    const native: PlatformSystemMedia = {
      configure: vi.fn(async (_generation, mediaEnabled, preventSleep) => ({
        generation: 1,
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
    Object.assign(mocks.platform, { kind: "mygo", os: "darwin", systemMedia: native });
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
    vi.stubGlobal("navigator", { mediaSession: web });
    vi.stubGlobal("window", { MediaMetadata: Metadata });
    const music = useMusicStore();
    music.playSong = {
      ...music.playSong,
      id: "synthetic-shell",
      platform: "synthetic",
      name: "Synthetic shell",
      artists: [{ id: "artist", name: "Synthetic artist" }],
      album: "Synthetic album",
      cover: "https://fixture.invalid/synthetic.png",
      path: undefined,
    };
    const settings = useSettingStore();
    settings.smtcOpen = true;
    settings.preventSleep = true;
    const status = useStatusStore();
    status.duration = 10000;
    status.playRate = 1.75;
    status.playStatus = true;
    const session = createShellSystemMediaSession()!;
    cleanups.push(() => session.dispose());
    await session.start();
    await flush();
    expect(native.configure).toHaveBeenCalledWith(0, false, true);
    expect(web.metadata).toMatchObject({
      title: "Synthetic shell",
      artist: "Synthetic artist",
      artwork: [{ src: "data:image/png;base64,iVBORsynthetic" }],
    });
    expect(web.setPositionState).toHaveBeenLastCalledWith({
      duration: 10,
      position: 0,
      playbackRate: 1.75,
    });
    handlers.get("nexttrack")!({ action: "nexttrack" });
    await flush();
    expect(mocks.player.nextOrPrev).toHaveBeenCalledWith("next");
    for (const method of ["set", "setPlayback", "setArtwork", "onCommand"] as const)
      expect(native[method]).not.toHaveBeenCalled();
    await session.dispose();
    expect(native.teardown).toHaveBeenCalledWith(1);
    expect(handlers.size).toBe(0);
  });
});
