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
  open: vi.fn<() => Promise<string | null>>(),
  clear: vi.fn(),
  active: true,
  invalidation: vi.fn<() => void>(),
  history: vi.fn(),
  lyrics: vi.fn(),
}));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: mocks.lookup }));
vi.mock("@/platform/localAudioSession", () => ({
  LocalAudioSession: class {
    constructor(invalidate: () => void) {
      mocks.invalidation.mockImplementation(invalidate);
    }
    open = mocks.open;
    clear = mocks.clear;
    get active() {
      return mocks.active;
    }
  },
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
vi.mock("./env", () => ({ isElectron: false, hasNativeSystemMedia: true }));
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
  mocks.active = true;
  mocks.open.mockResolvedValue("http://127.0.0.1:12345/ticket");
  mocks.lookup.mockReturnValue({
    ref: { grantToken: "grant", fileId: "file", relativePath: "song.mp3", version: "one" },
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { $message: { error: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Player authorized local audio", () => {
  it("loads the granted loopback source and preserves the normal seek path", async () => {
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false, 5000);
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.audio.play).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:12345/ticket", {
      fadeIn: false,
      autoPlay: false,
    });
    expect(mocks.audio.seek).toHaveBeenCalledWith(5);
    expect(mocks.history).toHaveBeenCalledOnce();
    mocks.active = false;
    mocks.invalidation();
    expect(mocks.audio.clearSource).toHaveBeenCalledOnce();
    await player.play();
    expect(mocks.audio.play).toHaveBeenCalledTimes(1);
    expect(mocks.status.playStatus).toBe(false);
  });

  it("keeps a cached local path unavailable when no current backend ref exists", async () => {
    mocks.lookup.mockReturnValue(undefined);
    const player = (await import("./player")).usePlayer();
    await player.initPlayer();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.audio.play).not.toHaveBeenCalled();
    expect(mocks.status.playLoading).toBe(false);
  });

  it("ignores an older granted URL after a newer local selection", async () => {
    let finish!: (url: string | null) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const player = (await import("./player")).usePlayer();
    const old = player.initPlayer();
    mocks.song.id = "mygo-local:new";
    await player.initPlayer();
    finish("http://127.0.0.1:12345/old");
    await old;
    expect(mocks.audio.play).toHaveBeenCalledTimes(1);
    expect(mocks.audio.play).not.toHaveBeenCalledWith(
      "http://127.0.0.1:12345/old",
      expect.anything(),
    );
  });
});
