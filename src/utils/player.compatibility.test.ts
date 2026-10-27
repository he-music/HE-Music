import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: Event) => void>(),
  nativeMedia: false,
  audio: {
    on: vi.fn(),
    off: vi.fn(),
    play: vi.fn<(src?: string, options?: { autoPlay?: boolean }) => Promise<void>>(),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    getErrorCode: vi.fn(() => 0),
    currentTime: 0,
    duration: 180,
    paused: true,
    src: "",
  },
  status: {
    playLoading: false,
    playStatus: false,
    playVolume: 0.7,
    playRate: 1,
    duration: 180000,
    currentTime: 0,
    progress: 0,
    lyricIndex: 0,
    $patch: vi.fn(),
  },
  song: {
    id: "a",
    platform: "test",
    name: "A",
    artists: [],
    album: "Album",
    links: [{ name: "128mp3" }],
  },
  settings: { smtcOpen: true, showSpectrums: true, songLevel: "128mp3" },
  data: { setHistory: vi.fn(), playList: [{ id: "a" }, { id: "b" }] },
  lyrics: vi.fn(),
  lyricIndex: vi.fn(() => 3),
  cover: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@/stores", () => ({
  useStatusStore: () => mocks.status,
  useMusicStore: () => ({
    playSong: mocks.song,
    songCover: "cover",
    getSongCover: () => "https://cover.example/cover.jpg",
  }),
  useDataStore: () => mocks.data,
  useSettingStore: () => mocks.settings,
}));
vi.mock("./audioManager", () => ({ default: mocks.audio }));
vi.mock("./songManager", () => ({
  default: {
    getPlaySongData: () => mocks.song,
    getPlayerInfoObj: () => ({ name: "A", artist: "Artist" }),
    getCoverColor: mocks.cover,
    getOnlineUrl: vi.fn().mockResolvedValue("https://audio.example/track.mp3"),
  },
}));
vi.mock("./lyricManager", () => ({
  default: { handleLyric: mocks.lyrics, calculateLyricIndex: mocks.lyricIndex },
}));
vi.mock("./env", () => ({
  isElectron: false,
  isMygo: true,
  get hasNativeSystemMedia() {
    return mocks.nativeMedia;
  },
}));
vi.mock("./helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

let player: ReturnType<typeof import("./player").usePlayer>;
async function loadPlayer(mediaSession?: object, metadata?: typeof MediaMetadata) {
  vi.stubGlobal("navigator", mediaSession ? { mediaSession } : {});
  vi.stubGlobal("window", {
    location: { protocol: "https:" },
    document: { title: "HE-Music" },
    $message: { error: mocks.message },
    MediaMetadata: metadata,
  });
  player = (await import("./player")).usePlayer();
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.callbacks.clear();
  mocks.nativeMedia = false;
  mocks.audio.duration = 180;
  Object.assign(mocks.status, {
    playLoading: false,
    playStatus: false,
    currentTime: 0,
    progress: 0,
    lyricIndex: 0,
  });
  mocks.audio.src = "";
  mocks.audio.paused = true;
  mocks.audio.currentTime = 0;
  mocks.audio.getErrorCode.mockReturnValue(0);
  mocks.audio.on.mockImplementation((event, callback) => mocks.callbacks.set(event, callback));
  mocks.status.$patch.mockImplementation((patch: object) => Object.assign(mocks.status, patch));
  mocks.audio.play.mockReset().mockImplementation(async (src, options) => {
    if (src) mocks.audio.src = src;
    if (options?.autoPlay !== false) {
      mocks.audio.paused = false;
      mocks.callbacks.get("play")?.(new Event("play"));
    }
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Player HTMLAudio compatibility", () => {
  it("keeps a policy-blocked track, lyrics and seek, then resumes on user play", async () => {
    await loadPlayer();
    const next = vi.spyOn(player, "nextOrPrev").mockResolvedValue(undefined);
    mocks.audio.play.mockImplementationOnce(async (src) => {
      mocks.audio.src = src ?? "";
      throw new DOMException("gesture required", "NotAllowedError");
    });
    await player.initPlayer(true, 12000);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.audio.play).toHaveBeenCalledOnce();
    expect(mocks.status.playLoading).toBe(false);
    expect(mocks.status.playStatus).toBe(false);
    expect(mocks.audio.src).toBe("https://audio.example/track.mp3");
    expect(mocks.audio.seek).toHaveBeenCalledWith(12);
    expect(mocks.lyrics).toHaveBeenCalledWith("a", "test", undefined);
    await player.play();
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.audio.play).toHaveBeenLastCalledWith(undefined, {
      fadeIn: false,
      fadeDuration: 0,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("handles policy refusal at the resume entry without treating it as a bad song", async () => {
    await loadPlayer();
    await player.initPlayer(false);
    const next = vi.spyOn(player, "nextOrPrev").mockResolvedValue(undefined);
    mocks.audio.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    await expect(player.play()).resolves.toBeUndefined();
    expect(mocks.status.playStatus).toBe(false);
    expect(next).not.toHaveBeenCalled();
    await player.play();
    expect(mocks.status.playStatus).toBe(true);
  });

  it("ignores a late policy rejection after a new initialization succeeds", async () => {
    await loadPlayer();
    let rejectOld: (error: Error) => void = () => {};
    mocks.audio.play.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectOld = reject)),
    );
    const old = player.initPlayer();
    await vi.waitFor(() => expect(mocks.audio.play).toHaveBeenCalledOnce());
    await player.initPlayer();
    rejectOld(new DOMException("blocked", "NotAllowedError"));
    await old;
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.lyrics).toHaveBeenCalledOnce();
  });

  it("ignores a late resume refusal after switching to a new source", async () => {
    await loadPlayer();
    await player.initPlayer(false);
    let rejectOld: (error: Error) => void = () => {};
    mocks.audio.play.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectOld = reject)),
    );
    const old = player.play();
    await player.initPlayer();
    rejectOld(new DOMException("blocked", "NotAllowedError"));
    await old;
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it.each([2, 3, 4])("retains normal media-error recovery for code %s", async (code) => {
    await loadPlayer();
    const next = vi.spyOn(player, "nextOrPrev").mockResolvedValue(undefined);
    const initialize = vi.spyOn(player, "initPlayer").mockResolvedValue(undefined);
    mocks.callbacks.get("error")?.(new CustomEvent("error", { detail: { errorCode: code } }));
    if (code === 2) expect(initialize).toHaveBeenCalledWith(true, 0);
    else expect(next).toHaveBeenCalledWith("next");
  });

  it("does not mistake a generic failure for a policy rejection", async () => {
    await loadPlayer();
    const next = vi.spyOn(player, "nextOrPrev").mockResolvedValue(undefined);
    mocks.audio.play.mockRejectedValueOnce(new Error("decode failure"));
    await player.initPlayer();
    expect(next).toHaveBeenCalledWith("next");
    expect(mocks.lyrics).not.toHaveBeenCalled();
  });

  it("preserves the existing millisecond lyric clock and seek units", async () => {
    await loadPlayer();
    mocks.audio.currentTime = 12.5;
    mocks.callbacks.get("timeupdate")?.(new Event("timeupdate"));
    expect(mocks.lyricIndex).toHaveBeenCalledWith(12500);
    expect(mocks.status.currentTime).toBe(12500);
    expect(mocks.status.lyricIndex).toBe(3);
    player.setSeek(42000);
    expect(mocks.audio.seek).toHaveBeenCalledWith(42);
    expect(mocks.status.currentTime).toBe(42000);
  });

  it.each([false, true])(
    "keeps nonzero restored seek with unknown duration and notifies subscribers (refused=%s)",
    async (refused) => {
      await loadPlayer();
      mocks.audio.duration = 0;
      if (refused) {
        mocks.audio.play.mockRejectedValueOnce(
          new DOMException("synthetic policy refusal", "NotAllowedError"),
        );
      }
      const notify = vi.fn();
      const off = player.onSeek(notify);
      await player.initPlayer(true, 12000);
      expect(mocks.audio.seek).toHaveBeenCalledWith(12);
      expect(notify).toHaveBeenCalledOnce();
      off();
      player.setSeek(0);
      expect(notify).toHaveBeenCalledOnce();
    },
  );

  it("notifies an explicit seek0 once and supports unsubscribe without timeupdate notifications", async () => {
    await loadPlayer();
    const notify = vi.fn();
    const off = player.onSeek(notify);
    player.setSeek(0);
    expect(mocks.audio.seek).toHaveBeenCalledWith(0);
    expect(notify).toHaveBeenCalledOnce();
    mocks.callbacks.get("timeupdate")?.(new Event("timeupdate"));
    expect(notify).toHaveBeenCalledOnce();
    off();
    player.setSeek(1000);
    expect(notify).toHaveBeenCalledOnce();
  });
});

describe("Player optional MediaSession API", () => {
  it("registers supported controls even when seekto is rejected", async () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
    const setActionHandler = vi.fn(
      (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
        if (action === "seekto") throw new DOMException("unsupported", "NotSupportedError");
        handlers.set(action, handler);
      },
    );
    await loadPlayer({ setActionHandler });
    await player.initPlayer(false);
    expect(setActionHandler).toHaveBeenCalledTimes(5);
    expect([...handlers.keys()]).toEqual(["play", "pause", "previoustrack", "nexttrack"]);
    await handlers.get("play")?.({ action: "play" });
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.lyrics).toHaveBeenCalledOnce();
  });

  it("plays when the host exposes neither setActionHandler nor MediaMetadata", async () => {
    await loadPlayer({});
    await player.initPlayer();
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.lyrics).toHaveBeenCalledOnce();
  });

  it("does not let a metadata constructor failure invalidate playback", async () => {
    class UnsupportedMetadata implements MediaMetadata {
      album = "";
      artist = "";
      artwork = [];
      title = "";
      constructor() {
        throw new DOMException("unsupported", "NotSupportedError");
      }
    }
    await loadPlayer({}, UnsupportedMetadata);
    await player.initPlayer();
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.lyrics).toHaveBeenCalledOnce();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("accepts Web seekto zero", async () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
    await loadPlayer({
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler) =>
        handlers.set(action, handler),
    });
    handlers.get("seekto")?.({ action: "seekto", seekTime: 0 });
    expect(mocks.audio.seek).toHaveBeenCalledWith(0);
  });

  it("suppresses duplicate navigator controls, metadata and position only with the native provider", async () => {
    mocks.nativeMedia = true;
    const setActionHandler = vi.fn();
    const setPositionState = vi.fn();
    const metadata = vi.fn();
    class SyntheticMetadata implements MediaMetadata {
      album = "";
      artist = "";
      artwork = [];
      title = "";
      constructor() {
        metadata();
      }
    }
    await loadPlayer({ setActionHandler, setPositionState }, SyntheticMetadata);
    await player.initPlayer();
    mocks.callbacks.get("timeupdate")?.(new Event("timeupdate"));
    expect(setActionHandler).not.toHaveBeenCalled();
    expect(setPositionState).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.lyrics).toHaveBeenCalledOnce();
  });
});
