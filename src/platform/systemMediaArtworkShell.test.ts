import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PlatformAdapter } from "./types";
import type { PlatformSystemMedia } from "./systemMedia";

const mocks = vi.hoisted(() => ({
  platform: {} as PlatformAdapter,
  getSizeCover: vi.fn<(song: { cover: string }, size?: number) => string>((song) => song.cover),
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
vi.mock("@/utils/songCover", () => ({ getSizeCover: mocks.getSizeCover }));
vi.mock("@/utils/blob", () => ({ default: {} }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/utils/helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  ...(await import("@/stores/status")),
  ...(await import("@/stores/music")),
  useDataStore: () => ({ playList: [] }),
}));
vi.stubGlobal("localStorage", {});
const { useMusicStore, useSettingStore, useStatusStore } = await import("@/stores");
const { createShellSystemMediaSession } = await import("@/composables/shellSystemMedia");
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
const sessions: Array<{ dispose(): Promise<void> }> = [];
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  fetchMock.mockReset().mockRejectedValue(new Error("Synthetic unavailable image"));
  mocks.getSizeCover.mockClear();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  vi.unstubAllGlobals();
});
function fixture(api = true) {
  const setArtwork = vi.fn(async () => {});
  const provider: PlatformSystemMedia = {
    configure: async (_generation, mediaEnabled, preventSleep) => ({
      generation: 1,
      mediaEnabled,
      keepAwakeRequested: preventSleep,
      metadataRequested: false,
    }),
    set: vi.fn(async () => {}),
    setPlayback: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: () => () => {},
    ...(api ? { setArtwork } : {}),
  };
  Object.assign(mocks.platform, { systemMedia: provider });
  const music = useMusicStore();
  music.playSong = {
    ...music.playSong,
    id: "artwork-fixture",
    platform: "synthetic",
    name: "Synthetic image",
    cover: "https://image.invalid/fixture.png",
    path: undefined,
  };
  const setting = useSettingStore();
  setting.smtcOpen = true;
  const status = useStatusStore();
  const session = createShellSystemMediaSession()!;
  sessions.push(session);
  return { session, music, setting, status, provider, setArtwork };
}

describe("shellSystemMedia artwork composition with actual Pinia getters", () => {
  it("uses the existing 512px cover getter and ignores progress, lyrics and Rate for fetch", async () => {
    const f = fixture();
    await f.session.start();
    await flush();
    expect(mocks.getSizeCover).toHaveBeenCalledWith(f.music.playSong, 512);
    expect(fetchMock).toHaveBeenCalledOnce();
    const writes = f.setArtwork.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      f.status.currentTime = i;
      f.status.progress = i;
      f.status.lyricIndex = i;
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(f.setArtwork).toHaveBeenCalledTimes(writes);
    f.status.playRate = 2;
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(f.provider.set).toHaveBeenLastCalledWith(1, 2, expect.objectContaining({ rate: 2 }));
  });

  it.each(["no-api", "disabled", "local", "empty", "untitled"])(
    "does not request guarded artwork: %s",
    async (guard) => {
      const f = fixture(guard !== "no-api");
      if (guard === "disabled") f.setting.smtcOpen = false;
      if (guard === "local") f.music.playSong.path = "/synthetic/local-guard";
      if (guard === "empty") f.music.playSong.id = "";
      if (guard === "untitled") f.music.playSong.name = "";
      await f.session.start();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.getSizeCover).not.toHaveBeenCalled();
    },
  );
});
