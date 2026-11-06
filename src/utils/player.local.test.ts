import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  song: {
    id: "mygo-local:file",
    platform: "local",
    path: "song.mp3",
    name: "Local",
    artists: "Artist",
    album: "Album",
    links: [],
  },
  music: { playSong: { id: "", platform: "", path: "", name: "" } },
  status: { playLoading: false, playStatus: false, playVolume: 1, playRate: 1 },
  audio: {
    on: vi.fn(),
    off: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    clearSource: vi.fn(),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    seek: vi.fn(),
    getErrorCode: vi.fn(() => 0),
  },
  lookup: vi.fn(),
  history: vi.fn(),
  lyrics: vi.fn(),
}));

vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: mocks.lookup }));
vi.mock("@/platform/localAudioSession", () => ({
  localAudioBlocked: () => false,
  registerLocalAudioStopper: () => {},
  blockLocalAudio: () => () => {},
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
  useSettingStore: () => ({ showSpectrums: true, smtcOpen: false }),
  useDataStore: () => ({ setHistory: mocks.history }),
}));
vi.mock("./audioManager", () => ({ default: mocks.audio }));
vi.mock("./songManager", () => ({ default: { getPlaySongData: () => mocks.song } }));
vi.mock("./lyricManager", () => ({ default: { handleLyric: mocks.lyrics } }));
vi.mock("./env", () => ({ isElectron: false, isMygo: true, hasNativeSystemMedia: true }));
vi.mock("./helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.song.id = "mygo-local:file";
  mocks.song.path = "song.mp3";
  mocks.status.playLoading = false;
  mocks.status.playStatus = false;
  mocks.lookup.mockReturnValue({
    path: "/fixture/song.mp3",
    ref: { grantToken: "grant", fileId: "file", relativePath: "song.mp3", version: "one" },
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    $message: { error: vi.fn() },
    __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Player local file audio", () => {
  it("loads the local HTTP URL and preserves the normal seek path", async () => {
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false, 5000);
    const url = "http://127.0.0.1:1234/session/__local/audio?path=%2Ffixture%2Fsong.mp3";
    expect(mocks.audio.play).toHaveBeenCalledOnce();
    expect(mocks.audio.play.mock.calls[0][0]).toContain(url + "&v=");
    expect(mocks.audio.play.mock.calls[0][1]).toEqual({ fadeIn: false, autoPlay: false, seek: 5 });
    expect(mocks.audio.seek).toHaveBeenCalledWith(5);
    expect(mocks.history).toHaveBeenCalledOnce();
  });

  it("keeps a cached local path unavailable when no current backend ref exists", async () => {
    mocks.lookup.mockReturnValue(undefined);
    const player = (await import("./player")).usePlayer();
    await player.initPlayer();
    expect(mocks.audio.play).not.toHaveBeenCalled();
    expect(mocks.status.playLoading).toBe(false);
  });
  it("passes the FLAC container hint to the browser driver", async () => {
    mocks.song.path = "我怀念的-孙燕姿.flac";
    mocks.lookup.mockReturnValue({ path: "/Music/我怀念的-孙燕姿.flac" });
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false);
    const [url, options] = mocks.audio.play.mock.calls[0];
    expect(new URL(url).searchParams.get("path")).toBe("/Music/我怀念的-孙燕姿.flac");
    expect(options).toMatchObject({ source: { platform: "local", format: "flac" } });
  });
});
