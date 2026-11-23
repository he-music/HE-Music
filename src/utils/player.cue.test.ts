import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
import type { ScanEntry } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const audio = {
    engineId: "web-audio" as PlaybackEngineId,
    currentTime: 0,
    duration: 30,
    paused: true,
    src: "",
    on: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    off: vi.fn(),
    setEngine: vi.fn(async (id: PlaybackEngineId) => {
      audio.engineId = id;
    }),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    play: vi.fn(
      async (
        url?: string,
        options: { seek?: number; autoPlay?: boolean; source?: { identity?: string } } = {},
      ) => {
        if (url !== undefined) {
          audio.currentTime = options.seek ?? 0;
          audio.src = options.source?.identity ?? url;
        }
        audio.paused = options.autoPlay === false;
        if (!audio.paused) listeners.get("playing")?.();
      },
    ),
    pause: vi.fn(async () => {
      audio.paused = true;
    }),
    clearSource: vi.fn(async () => {
      audio.paused = true;
      audio.src = "";
    }),
    seek: vi.fn((seek: number) => {
      audio.currentTime = seek;
    }),
    getErrorCode: vi.fn(() => 0),
  };
  const flags = { enable: false, waitSongEnd: false, remainTime: 0, time: 10 };
  const status = {
    playIndex: 0,
    playStatus: false,
    playLoading: false,
    playVolume: 1,
    playRate: 1,
    playSongMode: "repeat",
    currentTime: 0,
    duration: 0,
    autoClose: flags,
    $patch: (patch: object) => Object.assign(status, patch),
  };
  return {
    audio,
    listeners,
    status,
    entry: undefined as ScanEntry | undefined,
    queue: { playList: [] as SongInfo[], setHistory: vi.fn() },
    music: { playSong: undefined as SongInfo | undefined },
    settings: { playbackEngine: "web-audio" as PlaybackEngineId, getFadeTime: 0 },
  };
});

vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.settings,
  useDataStore: () => mocks.queue,
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: () => mocks.entry,
  localSongID: () => "mygo-local:file",
}));
vi.mock("./audioManager", () => ({ default: mocks.audio }));
vi.mock("./env", () => ({ isMygo: true, hasNativeSystemMedia: true }));
vi.mock("./helper", () => ({}));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("./songManager", () => ({
  default: {
    getPlaySongData: () => mocks.queue.playList[mocks.status.playIndex],
    getPlayerInfoObj: () => ({ name: "test", artist: "test" }),
  },
}));
vi.mock("./lyricManager", () => ({
  default: {
    handleLyric: vi.fn(),
    calculateLyricIndex: () => -1,
  },
}));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const track = (number: number): SongInfo => ({
  id: "mygo-local:file:cue:" + number,
  name: "Track " + number,
  path: "album.flac",
  platform: "local",
  subtitle: "",
  artists: "Artist",
  album: "Album",
  duration: 10,
  mv_id: "",
  cover: "",
  links: [],
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.listeners.clear();
  Object.assign(mocks.status, {
    playIndex: 0,
    playStatus: false,
    playLoading: false,
    currentTime: 0,
    duration: 0,
    playSongMode: "repeat",
  });
  Object.assign(mocks.status.autoClose, { enable: false, waitSongEnd: false, remainTime: 0 });
  Object.assign(mocks.audio, { engineId: "web-audio", paused: true, src: "", currentTime: 0 });
  mocks.settings.playbackEngine = "web-audio";
  mocks.queue.playList = [track(1), track(2), track(3)];
  mocks.music.playSong = mocks.queue.playList[0];
  mocks.entry = {
    path: "/fixture/album.flac",
    relativePath: "album.flac",
    filename: "album.flac",
    size: 500,
    ref: { grantToken: "grant", fileId: "file", version: "one", relativePath: "album.flac" },
    metadata: { DurationSeconds: 30, Codec: "flac" } as ScanEntry["metadata"],
    cue: { tracks: [0, 750, 1500].map((startFrame, index) => ({ number: index + 1, startFrame })) },
  };
  vi.stubGlobal("window", {
    document: { title: "" },
    $message: { error: vi.fn() },
    __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:9876/session",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each<PlaybackEngineId>(["web-audio", "mpv"])(
  "plays track-relative time and crosses a same-file boundary without loading or seeking (%s)",
  async (engine) => {
    mocks.settings.playbackEngine = engine;
    mocks.status.playIndex = 1;
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(true, 2500);
    expect(mocks.audio.play).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ seek: 12.5 }),
    );
    expect(player.getSeek()).toBe(2500);
    expect(player.getDuration()).toBe(10_000);
    player.setSeek(3000);
    expect(mocks.audio.seek).toHaveBeenCalledWith(13);
    mocks.listeners.get("seeked")?.();
    mocks.audio.currentTime = 20.125;
    mocks.listeners.get("timeupdate")?.();
    expect(mocks.music.playSong?.id).toBe(track(3).id);
    expect(mocks.status).toMatchObject({
      playIndex: 2,
      duration: 10_000,
      currentTime: 125,
      playStatus: true,
    });
    expect(mocks.audio.play).toHaveBeenCalledOnce();
    expect(mocks.audio.seek).toHaveBeenCalledOnce();
  },
);

it("preserves logical track, offset and pause on engine switch", async () => {
  mocks.status.playIndex = 1;
  const player = (await import("./player")).usePlayer();
  await player.initPlayer(false, 2500);
  await player.changePlaybackOutput("mpv");
  expect(mocks.audio.play).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ seek: 12.5, autoPlay: false }),
  );
  expect(mocks.music.playSong?.id).toBe(track(2).id);
  expect(player.getSeek()).toBe(2500);
});

it.each<PlaybackEngineId>(["web-audio", "mpv"])(
  "holds the second track during a drag across its boundary, then seeks within it (%s)",
  async (engine) => {
    mocks.settings.playbackEngine = engine;
    mocks.status.playIndex = 1;
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(true, 9_700);
    const release = player.beginProgressDrag();
    expect(mocks.audio.paused).toBe(true);

    mocks.audio.currentTime = 20.01;
    mocks.listeners.get("timeupdate")?.();
    vi.advanceTimersByTime(600);
    expect(mocks.status.playIndex).toBe(1);
    expect(mocks.audio.seek).not.toHaveBeenCalled();

    release(4_000);
    expect(mocks.audio.seek).toHaveBeenCalledExactlyOnceWith(14);
    expect(mocks.audio.paused).toBe(false);
    expect(player.getSeek()).toBe(4_000);
    expect(mocks.audio.play).toHaveBeenCalledTimes(2);
    expect(mocks.audio.play.mock.calls[1][0]).toBeUndefined();
  },
);

it("does not resume playback after a manual pause during a CUE drag", async () => {
  mocks.status.playIndex = 1;
  const player = (await import("./player")).usePlayer();
  await player.initPlayer(true, 1_000);
  const release = player.beginProgressDrag();
  await player.pause();
  release(4_000);
  expect(mocks.audio.seek).toHaveBeenCalledExactlyOnceWith(14);
  expect(mocks.audio.paused).toBe(true);
  expect(mocks.audio.play).toHaveBeenCalledOnce();
});

it("does not send a late drag release to a different cue track", async () => {
  mocks.status.playIndex = 1;
  const player = (await import("./player")).usePlayer();
  await player.initPlayer(false, 1_000);
  const release = player.beginProgressDrag();
  mocks.status.playIndex = 2;
  await player.initPlayer(false);
  release(4_000);
  expect(mocks.audio.seek).not.toHaveBeenCalled();
  expect(player.getSeek()).toBe(0);
});

it("loops one CUE track rather than moving into the next track", async () => {
  mocks.status.playIndex = 1;
  mocks.status.playSongMode = "repeat-once";
  const player = (await import("./player")).usePlayer();
  await player.initPlayer(true);
  mocks.audio.currentTime = 20;
  vi.advanceTimersByTime(10_000);
  expect(mocks.status.playIndex).toBe(1);
  expect(mocks.audio.seek).toHaveBeenCalledWith(10);
  expect(mocks.audio.play).toHaveBeenCalledOnce();
});

it("restarts at the last track’s own offset when the source reports EOF in single-track repeat", async () => {
  mocks.status.playIndex = 2;
  mocks.status.playSongMode = "repeat-once";
  const player = (await import("./player")).usePlayer();
  await player.initPlayer(true);
  mocks.audio.currentTime = 30;
  mocks.listeners.get("ended")?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.status.playIndex).toBe(2);
  expect(mocks.audio.play).toHaveBeenCalledTimes(2);
  expect(mocks.audio.play).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ seek: 20 }),
  );
});
