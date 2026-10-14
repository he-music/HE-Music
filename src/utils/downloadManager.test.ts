import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SongInfo } from "@/types/main.hemusic";

const mocks = vi.hoisted(() => ({
  isElectron: false,
  useDataStore: vi.fn(),
  songUrl: vi.fn(),
  saveAs: vi.fn(),
  invoke: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("@/utils/env", () => ({
  get isElectron() {
    return mocks.isElectron;
  },
}));
vi.mock("@/stores", () => ({
  useDataStore: mocks.useDataStore,
  useSettingStore: () => ({
    downloadPath: "/downloads",
    fileNameFormat: "artist-title",
    folderStrategy: "none",
    downloadLyric: false,
  }),
}));
vi.mock("@/api/song", () => ({ songUrl: mocks.songUrl, songLyric: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: mocks.saveAs }));
vi.mock("@/utils/songManager", () => ({
  default: { getPlayerInfoObj: (song: SongInfo) => ({ name: song.name, artist: "歌手" }) },
}));
vi.mock("@/utils/lyric", () => ({
  removeWordLyric: vi.fn(),
  romaSeparator: "",
  transSeparator: "",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const song: SongInfo = {
  id: "song-1",
  platform: "test",
  name: "歌曲",
  subtitle: "",
  album: "专辑",
  duration: 180,
  mv_id: "0",
  cover: "",
  links: [{ name: "320mp3", quality: 320, format: "mp3", size: "0", url: "" }],
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.isElectron = false;
  mocks.songUrl.mockResolvedValue({ url: "https://example.com/song.mp3", format: "mp3" });
  vi.stubGlobal("window", {
    $message: { success: vi.fn(), error: vi.fn() },
    electron: { ipcRenderer: { invoke: mocks.invoke, on: () => mocks.removeListener } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("网页端直接下载", () => {
  it("交给浏览器下载，不访问下载任务状态或 Electron", async () => {
    const { default: manager } = await import("./downloadManager");
    const result = await manager.downloadInBrowser(song, "320mp3");

    expect(result.success).toBe(true);
    expect(mocks.songUrl).toHaveBeenCalledWith(song.id, song.platform, 320, "mp3");
    expect(mocks.saveAs).toHaveBeenCalledWith("https://example.com/song.mp3", "歌手 - 歌曲.mp3");
    expect(mocks.useDataStore).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("链接获取失败后允许再次直接下载，不留下失败任务", async () => {
    mocks.songUrl.mockRejectedValueOnce(new Error("链接获取失败"));
    const { default: manager } = await import("./downloadManager");

    expect(await manager.downloadInBrowser(song, "320mp3")).toEqual({
      success: false,
      message: "download.get_url_fail",
    });
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect((await manager.downloadInBrowser(song, "320mp3")).success).toBe(true);
    expect(mocks.useDataStore).not.toHaveBeenCalled();
  });

  it("浏览器下载调用抛错时返回失败，不创建失败任务", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.saveAs.mockImplementationOnce(() => {
      throw new Error("浏览器下载失败");
    });
    const { default: manager } = await import("./downloadManager");

    expect(await manager.downloadInBrowser(song, "320mp3")).toEqual({
      success: false,
      message: "message.download_fail",
    });
    expect(mocks.useDataStore).not.toHaveBeenCalled();
  });

  it("前一个链接请求未结束时，另一个下载也能直接开始", async () => {
    let resolveFirst!: (value: { url: string; format: string }) => void;
    const first = new Promise<{ url: string; format: string }>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.songUrl.mockReturnValueOnce(first);
    const { default: manager } = await import("./downloadManager");

    const pending = manager.downloadInBrowser(song, "320mp3");
    const second = await manager.downloadInBrowser({ ...song, id: "song-2" }, "320mp3");
    expect(second.success).toBe(true);
    expect(mocks.songUrl).toHaveBeenCalledTimes(2);
    expect(mocks.saveAs).toHaveBeenCalledTimes(1);

    resolveFirst({ url: "https://example.com/first.mp3", format: "mp3" });
    expect((await pending).success).toBe(true);
    expect(mocks.saveAs).toHaveBeenCalledTimes(2);
    expect(mocks.useDataStore).not.toHaveBeenCalled();
  });

  it("网页端不能通过任务管理入口添加或重试队列任务", async () => {
    const { default: manager } = await import("./downloadManager");

    await manager.addDownload(song, "320mp3");
    manager.retryDownload(song);
    manager.retryAllDownloads();
    expect(mocks.useDataStore).not.toHaveBeenCalled();
    expect(mocks.songUrl).not.toHaveBeenCalled();
  });
});

describe("桌面端下载任务", () => {
  it("下载失败时仍保留任务供下载管理重试", async () => {
    mocks.isElectron = true;
    const tasks: Array<{ song: SongInfo; quality: string }> = [];
    const store = {
      downloadingSongs: tasks,
      addDownloadingSong: vi.fn((song: SongInfo, quality: string) => {
        tasks.push({ song, quality });
      }),
      updateDownloadStatus: vi.fn(),
      markDownloadFailed: vi.fn(),
      removeDownloadingSong: vi.fn(),
    };
    mocks.useDataStore.mockReturnValue(store);
    mocks.invoke.mockResolvedValue({ status: "error", message: "写入失败" });
    const { default: manager } = await import("./downloadManager");

    await manager.addDownload(song, "320mp3");
    await vi.waitFor(() => expect(store.markDownloadFailed).toHaveBeenCalledWith(song));
    expect(tasks).toHaveLength(1);
    expect(store.removeDownloadingSong).not.toHaveBeenCalled();
    expect(mocks.removeListener).toHaveBeenCalledOnce();
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });
});
