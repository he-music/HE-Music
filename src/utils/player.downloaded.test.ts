import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadedPlayback } from "@/platform/downloadedPlayback";
import { localEntry } from "@/test/fixtures/localMedia";

const mocks = vi.hoisted(() => ({
  song: { id: "online", platform: "test", name: "Online", links: [], path: undefined },
  music: { playSong: { id: "", platform: "", name: "", path: undefined }, songCover: "" },
  status: {
    playLoading: false,
    playStatus: false,
    playVolume: 1,
    playRate: 1,
    playQuality: "320mp3",
    selectedQuality: "320mp3",
  },
  setting: { preferDownloaded: true, songLevel: "320mp3", smtcOpen: false },
  resolve: vi.fn(),
  online: vi.fn(),
  lyrics: vi.fn(),
  history: vi.fn(),
  owner: {},
  stopper: vi.fn(),
  audio: {
    on: vi.fn(),
    off: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    clearSource: vi.fn(),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    getErrorCode: vi.fn(() => 0),
    currentTime: 4,
    seek: vi.fn(),
  },
}));
vi.mock("@/platform/downloadedPlayback", () => ({ resolveDownloadedPlayback: mocks.resolve }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return mocks.owner;
    },
  },
}));
vi.mock("@/platform/localAudioSession", () => ({
  localAudioBlocked: () => false,
  registerLocalAudioStopper: mocks.stopper,
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.setting,
  useDataStore: () => ({ setHistory: mocks.history }),
}));
vi.mock("./audioManager", () => ({ default: mocks.audio }));
vi.mock("./songManager", () => ({
  default: {
    getPlaySongData: () => mocks.song,
    getOnlineSource: mocks.online,
    getCoverColor: vi.fn(),
    getPlayerInfoObj: () => ({ name: "Online", artist: "Artist" }),
  },
}));
vi.mock("./playbackQuality", () => ({
  selectPlaybackQuality: () => ({ name: "320mp3", format: "mp3" }),
}));
vi.mock("./lyricManager", () => ({ default: { handleLyric: mocks.lyrics } }));
vi.mock("./env", () => ({ isMygo: true, hasNativeSystemMedia: true }));
vi.mock("./helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

let downloaded: DownloadedPlayback;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.setting.preferDownloaded = true;
  mocks.status.playLoading = false;
  mocks.status.playStatus = false;
  mocks.audio.play.mockResolvedValue(undefined);
  mocks.audio.pause.mockResolvedValue(undefined);
  mocks.audio.clearSource.mockResolvedValue(undefined);
  mocks.online.mockResolvedValue({ url: "https://audio.fixture.invalid/song.mp3", format: "mp3" });
  downloaded = {
    key: "task:version",
    entry: localEntry(),
    url: "http://127.0.0.1/local.mp3",
    source: { platform: "local", format: "mp3" },
  };
  mocks.resolve.mockImplementation(async (_song, _quality, _engine, _owner, current, excluded) =>
    current() && !excluded.has(downloaded.key) ? downloaded : undefined,
  );
  vi.stubGlobal("window", { $message: { error: vi.fn() }, document: { title: "" } });
  vi.stubGlobal("navigator", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("播放器已下载优先", () => {
  it("本地文件播放保留在线身份并使用文件歌词", async () => {
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false, 3000);
    expect(mocks.audio.play).toHaveBeenCalledWith(
      downloaded.url,
      expect.objectContaining({ autoPlay: false, seek: 3, source: downloaded.source }),
    );
    expect(mocks.online).not.toHaveBeenCalled();
    expect(mocks.music.playSong).toBe(mocks.song);
    expect(mocks.lyrics).toHaveBeenCalledWith("online", "test", undefined, downloaded.entry);
    expect(mocks.history).toHaveBeenCalledWith(mocks.song);
  });

  it("关闭偏好或没有有效文件时正常在线取源", async () => {
    mocks.setting.preferDownloaded = false;
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.online).toHaveBeenCalledOnce();
  });

  it("本地副本失败后回退在线一次并保留进度", async () => {
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false);
    const handler = mocks.audio.on.mock.calls.find(([name]) => name === "error")?.[1];
    handler({ detail: { errorCode: 2, errorMessage: "missing" } });
    await vi.waitFor(() => expect(mocks.online).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.audio.play).toHaveBeenCalledTimes(2));
    expect(mocks.audio.play.mock.calls[1][1]).toMatchObject({ autoPlay: false, seek: 4 });
  });

  it("预检期间暂停不会在文件就绪后自动出声", async () => {
    let finish!: (value: DownloadedPlayback) => void;
    mocks.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const player = (await import("./player")).usePlayer();
    const pending = player.initPlayer(true);
    await player.pause();
    finish(downloaded);
    await pending;
    expect(mocks.audio.play.mock.calls[0][1].autoPlay).toBe(false);
  });

  it("目录撤销能够停止以在线身份播放的本地文件", async () => {
    const player = (await import("./player")).usePlayer();
    await player.initPlayer(false);
    const stop = mocks.stopper.mock.calls[0][0];
    stop("grant");
    expect(mocks.audio.clearSource).toHaveBeenCalled();
    expect(mocks.status.playLoading).toBe(false);
    expect(mocks.status.playStatus).toBe(false);
  });
});
