import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: unknown) => void>(),
  audio: {
    on: vi.fn(),
    off: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    seek: vi.fn(),
    getErrorCode: vi.fn(),
    currentTime: 0,
  },
  status: { playLoading: false, playStatus: false, playVolume: 1, playRate: 1 },
  song: { id: "a", platform: "test", name: "A" },
  data: { setHistory: vi.fn(), playList: [] },
  lyrics: vi.fn(),
  cover: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/stores", () => ({
  useStatusStore: () => mocks.status,
  useMusicStore: () => ({ playSong: mocks.song, songCover: "cover" }),
  useDataStore: () => mocks.data,
  useSettingStore: () => ({ smtcOpen: false, showSpectrums: true }),
}));
vi.mock("./audioManager", () => ({ default: mocks.audio }));
vi.mock("./songManager", () => ({
  default: {
    getPlaySongData: () => mocks.song,
    getCoverColor: mocks.cover,
  },
}));
vi.mock("./lyricManager", () => ({ default: { handleLyric: mocks.lyrics } }));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("./time", () => ({ calculateProgress: vi.fn(), msToS: vi.fn() }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

// Exercise the real event handler and initialization with browser/audio boundaries mocked.
let player: any;
let dialog: any;
let destroy: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.callbacks.clear();
  mocks.audio.currentTime = 0;
  mocks.audio.play.mockReset().mockResolvedValue(undefined);
  mocks.audio.getErrorCode.mockReturnValue(4);
  mocks.audio.on.mockImplementation((name, callback) => mocks.callbacks.set(name, callback));
  destroy = vi.fn();
  mocks.warning.mockImplementation((options) => {
    dialog = options;
    return { destroy };
  });
  vi.stubGlobal("window", {
    location: { protocol: "https:" },
    open: vi.fn(),
    $dialog: { warning: mocks.warning },
    $message: { error: vi.fn() },
  });
  vi.stubGlobal("navigator", {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { usePlayer } = await import("./player");
  player = usePlayer();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function failHttp(code = 4, autoPlay = true, seek = 0) {
  mocks.audio.play.mockImplementationOnce(async () => {
    mocks.callbacks.get("error")?.({ detail: { errorCode: code } });
    throw new Error("media failed");
  });
  await expect(player.createPlayer("http://audio.example/a.mp3", autoPlay, seek)).rejects.toThrow();
}

describe("HTTP playback recovery", () => {
  it("keeps the dialog open when opening HTTPS and restores full initialization on retry", async () => {
    await failHttp(4, true, 12000);
    expect(dialog.onPositiveClick()).toBe(false);
    expect(window.open).toHaveBeenCalledWith(
      "https://audio.example/a.mp3",
      "_blank",
      "noopener,noreferrer",
    );
    expect(mocks.lyrics).not.toHaveBeenCalled();
    dialog.onNegativeClick();
    await vi.waitFor(() => expect(mocks.data.setHistory).toHaveBeenCalledWith(mocks.song));
    expect(mocks.audio.play).toHaveBeenLastCalledWith("https://audio.example/a.mp3", {
      fadeIn: false,
      autoPlay: true,
    });
    expect(mocks.audio.seek).toHaveBeenCalledWith(12);
    expect(mocks.lyrics).toHaveBeenCalledWith("a", "test", undefined);
    expect(mocks.cover).toHaveBeenCalledWith("cover");
  });

  it("ignores a stale dialog after another playback request", async () => {
    await failHttp();
    const oldDialog = dialog;
    // Exercise initPlayer's invalidation before any new URL resolution.
    player.selectPlayQuality = () => null;
    vi.spyOn(player, "handlePlaybackError").mockResolvedValue(undefined);
    await player.initPlayer();
    expect(destroy).toHaveBeenCalled();
    mocks.audio.play.mockClear();
    oldDialog.onNegativeClick();
    oldDialog.onPositiveClick();
    expect(mocks.audio.play).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("preserves normal recovery for decode errors", async () => {
    const fallback = vi.spyOn(player, "handlePlaybackError").mockResolvedValue(undefined);
    await failHttp(3);
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(3);
  });

  it("deduplicates dialogs and resumes recovery on dismissal without prompting the same URL again", async () => {
    const fallback = vi.spyOn(player, "handlePlaybackError").mockResolvedValue(undefined);
    await failHttp(2);
    mocks.callbacks.get("error")?.({ detail: { errorCode: 2 } });
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    dialog.onClose();
    dialog.onEsc();
    expect(fallback).toHaveBeenCalledTimes(1);
    await failHttp(2);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("routes HTTPS retry failures through normal error recovery", async () => {
    const fallback = vi.spyOn(player, "handlePlaybackError").mockResolvedValue(undefined);
    await failHttp();
    mocks.audio.play.mockImplementationOnce(async () => {
      mocks.callbacks.get("error")?.({ detail: { errorCode: 4 } });
      throw new Error("TLS unavailable");
    });
    dialog.onNegativeClick();
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledWith(4));
    expect(mocks.warning).toHaveBeenCalledTimes(1);
  });

  it("preserves preload intent and suppresses stale initialization side effects", async () => {
    await failHttp(4, false);
    dialog.onNegativeClick();
    await vi.waitFor(() =>
      expect(mocks.audio.play).toHaveBeenLastCalledWith("https://audio.example/a.mp3", {
        fadeIn: false,
        autoPlay: false,
      }),
    );
    let resolve!: () => void;
    mocks.audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const pending = player.createPlayer("https://audio.example/old.mp3", true, 1000);
    player.playRequestId++;
    mocks.lyrics.mockClear();
    mocks.audio.seek.mockClear();
    resolve();
    await pending;
    expect(mocks.lyrics).not.toHaveBeenCalled();
    expect(mocks.audio.seek).not.toHaveBeenCalled();
  });
});
