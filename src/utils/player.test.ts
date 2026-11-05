import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mygo: false,
  sourceFormat: "",
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
    src: "",
    paused: true,
    readyState: 0,
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
    getPlayerInfoObj: () => ({ name: "A", artist: "Artist" }),
    getCoverColor: mocks.cover,
    getOnlineSource: vi.fn(async (_id: string, _platform: string, link: { format: string }) => ({
      url: "https://audio.example/next.mp3",
      format: mocks.sourceFormat || link.format,
    })),
  },
}));
vi.mock("./lyricManager", () => ({ default: { handleLyric: mocks.lyrics } }));
vi.mock("./env", () => ({
  isElectron: false,
  get isMygo() {
    return mocks.mygo;
  },
  hasNativeSystemMedia: false,
}));
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
  mocks.mygo = false;
  mocks.sourceFormat = "";
  mocks.song.platform = "test";
  mocks.audio.currentTime = 0;
  mocks.audio.src = "";
  mocks.audio.paused = true;
  mocks.audio.readyState = 0;
  mocks.status.playLoading = false;
  mocks.status.playStatus = false;
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
    document: { title: "HE-Music" },
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
describe("online source format admission", () => {
  it.each([
    ["migu", "m4a", true],
    ["kuwo", "flac", true],
    ["kugou", "flac", true],
    ["migu", "flac", true],
    ["qq", "flac", true],
    ["migu", "mp3", false],
    ["qq", "m4a", false],
  ] as const)("passes a source MIME hint only for %s/%s", async (platform, format, typed) => {
    mocks.song.platform = platform;
    vi.spyOn(player, "selectPlayQuality").mockReturnValue({ name: "test", format });
    await player.initPlayer(false);
    expect(mocks.audio.play).toHaveBeenCalledWith("https://audio.example/next.mp3", {
      fadeIn: false,
      autoPlay: false,
      ...(typed ? { source: { platform, format } } : {}),
    });
  });
  it.each([
    ["kuwo", "mflac", "flac"],
    ["soda", "flac", "m4a"],
    ["soda", "aac", "m4a"],
  ])("uses the decrypted container hint for mygo %s/%s", async (platform, format, output) => {
    mocks.mygo = true;
    mocks.song.platform = platform;
    mocks.sourceFormat = output;
    vi.spyOn(player, "selectPlayQuality").mockReturnValue({ name: "test", format });
    await player.initPlayer(false);
    expect(mocks.audio.play).toHaveBeenCalledWith(
      "https://audio.example/next.mp3",
      expect.objectContaining({ source: { platform, format: output } }),
    );
  });
  it("uses the actual returned format when an encrypted quality falls back to MP3", async () => {
    mocks.mygo = true;
    mocks.song.platform = "kuwo";
    mocks.sourceFormat = "mp3";
    vi.spyOn(player, "selectPlayQuality").mockReturnValue({ name: "test", format: "mflac" });
    await player.initPlayer(false);
    expect(mocks.audio.play.mock.calls[0]?.[1]).not.toHaveProperty("source");
  });
});

describe("media buffering state", () => {
  const emit = (name: string) => {
    const listener = mocks.callbacks.get(name);
    expect(listener, `missing ${name} handler`).toBeDefined();
    listener?.(new Event(name));
  };

  it("keeps a pending start loading until actual playing, not merely canplay", () => {
    mocks.audio.paused = false;
    emit("play");
    expect(mocks.status.playStatus).toBe(true);
    expect(mocks.status.playLoading).toBe(true);
    emit("canplay");
    expect(mocks.status.playLoading).toBe(true);
    emit("playing");
    expect(mocks.status.playLoading).toBe(false);
    emit("canplay");
    expect(mocks.status.playLoading).toBe(false);
  });

  it.each(["waiting", "stalled"])(
    "shows %s as buffering and clears it on playback or pause",
    (event) => {
      mocks.audio.paused = false;
      mocks.status.playStatus = true;
      emit(event);
      expect(mocks.status.playLoading).toBe(true);
      emit("playing");
      expect(mocks.status.playLoading).toBe(false);
      emit(event);
      mocks.audio.paused = true;
      emit("pause");
      expect(mocks.status.playLoading).toBe(false);
      expect(mocks.status.playStatus).toBe(false);
    },
  );

  it("does not mark buffered playback as waiting merely because the fetch stalled", () => {
    mocks.audio.paused = false;
    mocks.audio.readyState = 4;
    mocks.status.playStatus = true;
    emit("stalled");
    expect(mocks.status.playLoading).toBe(false);
    mocks.audio.readyState = 2;
    emit("stalled");
    expect(mocks.status.playLoading).toBe(true);
  });

  it("finishes a paused preload when canplay arrives", () => {
    mocks.status.playLoading = true;
    emit("canplay");
    expect(mocks.status.playLoading).toBe(false);
    expect(mocks.status.playStatus).toBe(false);
  });
});

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

describe("unsupported desktop startup capabilities", () => {
  it("ignores desktop lyric actions without an Electron bridge", () => {
    expect(() => player.toggleDesktopLyric()).not.toThrow();
    expect(() => player.setDesktopLyricShow(true)).not.toThrow();
    expect(mocks.status).not.toHaveProperty("showDesktopLyric");
  });

  it("does not open a persisted local song without desktop support", async () => {
    const originalSong = { ...mocks.song };
    Object.assign(mocks.song, { path: "/music/old.mp3" });
    try {
      const create = vi.spyOn(player, "createPlayer");
      mocks.status.playLoading = true;
      mocks.status.playStatus = true;
      await player.initPlayer();
      expect(create).not.toHaveBeenCalled();
      expect(mocks.status.playLoading).toBe(false);
      expect(mocks.status.playStatus).toBe(false);
    } finally {
      Reflect.deleteProperty(mocks.song, "path");
      Object.assign(mocks.song, originalSong);
    }
  });

  it("does not resume stale online audio after selecting an unsupported local song", async () => {
    const originalSong = { ...mocks.song };
    mocks.audio.src = "https://audio.example/previous.mp3";
    Object.assign(mocks.song, { path: "/music/old.mp3" });
    try {
      await player.initPlayer();
      await player.playOrPause();
      expect(mocks.audio.play).not.toHaveBeenCalled();
      expect(mocks.status.playStatus).toBe(false);

      Reflect.deleteProperty(mocks.song, "path");
      Object.assign(mocks.song, originalSong);
      vi.spyOn(player, "selectPlayQuality").mockReturnValue({ name: "standard" });
      await player.initPlayer();
      expect(mocks.audio.play).toHaveBeenLastCalledWith("https://audio.example/next.mp3", {
        fadeIn: false,
        autoPlay: true,
      });
    } finally {
      Reflect.deleteProperty(mocks.song, "path");
      Object.assign(mocks.song, originalSong);
    }
  });
});
