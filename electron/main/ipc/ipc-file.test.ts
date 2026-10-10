import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Options } from "electron-dl";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  download: vi.fn(),
  send: vi.fn(),
  picture: vi.fn(),
  createFile: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "unused" },
  BrowserWindow: { fromWebContents: () => ({ webContents: { send: mocks.send } }) },
  ipcMain: { handle: mocks.handle, on: vi.fn() },
}));
vi.mock("electron-dl", () => ({ download: mocks.download }));
vi.mock("node-taglib-sharp", () => ({
  File: { createFromPath: mocks.createFile },
  Picture: { fromPath: mocks.picture },
  TagTypes: { AllTags: 1 },
}));
vi.mock("../utils/helper", () => ({}));
vi.mock("../logger", () => ({ ipcLog: { warn: mocks.warn, error: vi.fn() } }));
vi.mock("../i18n", () => ({ t: (key: string) => key }));

import initFileIpc from "./ipc-file";

describe("download-file IPC", () => {
  let directory: string;
  let temporaryCover: string | undefined;
  let actualSongPath: string | undefined;

  const invoke = (options: Record<string, unknown> = {}) => {
    const registration = mocks.handle.mock.calls.find(([channel]) => channel === "download-file");
    if (!registration) throw new Error("download-file handler was not registered");
    return registration[1]({ sender: {} }, "https://example.test/song", {
      fileName: "歌曲",
      fileType: "mp3",
      path: directory,
      ...options,
    });
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), "he-music-download-test-"));
    temporaryCover = undefined;
    actualSongPath = undefined;
    initFileIpc();
    mocks.download.mockImplementation(async (_win, url: string, options: Options) => {
      if (!options.directory || !options.filename) throw new Error("missing download destination");
      const path =
        url.endsWith("/song") && actualSongPath
          ? actualSongPath
          : join(options.directory, options.filename);
      await writeFile(path, url.endsWith("/song") ? "new audio" : "new cover");
      return { getSavePath: () => path };
    });
    mocks.picture.mockReturnValue({});
    mocks.createFile.mockReturnValue({
      removeTags: vi.fn(),
      save: vi.fn(),
      dispose: vi.fn(),
      tag: {},
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (temporaryCover) await rm(temporaryCover, { recursive: true, force: true });
  });

  it("同名音频不覆盖时跳过下载和所有侧车操作", async () => {
    await writeFile(join(directory, "歌曲.mp3"), "old audio");
    await writeFile(join(directory, "歌曲.jpg"), "old cover");
    expect(await invoke({ overwrite: false, saveMetaFile: true })).toEqual({
      status: "skipped",
      message: "message.file_exists",
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "歌曲.mp3"), "utf8")).toBe("old audio");
    expect(await readFile(join(directory, "歌曲.jpg"), "utf8")).toBe("old cover");
  });

  it("将音频覆盖策略传递给 electron-dl 并转发进度标识", async () => {
    await writeFile(join(directory, "歌曲.mp3"), "old audio");
    expect(await invoke({ overwrite: true, songData: { id: 123, platform: "netease" } })).toEqual({
      status: "success",
    });
    const options: Options = mocks.download.mock.calls[0][2];
    expect(options.overwrite).toBe(true);
    options.onProgress?.({ percent: 0.5, transferredBytes: 50, totalBytes: 100 });
    expect(mocks.send).toHaveBeenCalledWith("download-progress", {
      percent: 0.5,
      transferredBytes: 50,
      totalBytes: 100,
      id: 123,
      platform: "netease",
    });
    expect(await readFile(join(directory, "歌曲.mp3"), "utf8")).toBe("new audio");
  });

  it("根据实际音频保存路径命名歌词和封面，独立侧车沿用覆盖行为", async () => {
    const actualDirectory = join(directory, "actual");
    await mkdir(actualDirectory);
    actualSongPath = join(actualDirectory, "歌曲 (1).mp3");
    await writeFile(join(actualDirectory, "歌曲 (1).jpg"), "old cover");
    await writeFile(join(actualDirectory, "歌曲 (1).lrc"), "old lyric");
    expect(
      await invoke({
        overwrite: false,
        saveMetaFile: true,
        downloadLyric: true,
        lyric: "new lyric",
        songData: { cover: "https://example.test/cover" },
      }),
    ).toEqual({ status: "success" });
    expect(mocks.download.mock.calls[0][2].overwrite).toBe(false);
    expect(mocks.download.mock.calls[1][2]).toMatchObject({
      directory: actualDirectory,
      filename: "歌曲 (1).jpg",
      overwrite: true,
    });
    expect(await readFile(join(actualDirectory, "歌曲 (1).jpg"), "utf8")).toBe("new cover");
    expect(await readFile(join(actualDirectory, "歌曲 (1).lrc"), "utf8")).toBe("new lyric");
    await expect(access(join(directory, "歌曲.lrc"))).rejects.toThrow();
  });

  it.each(["success", "cover failure", "metadata failure"])(
    "仅内嵌封面使用隔离目录并清理（%s），保留用户已有封面",
    async (scenario) => {
      await writeFile(join(directory, "歌曲.jpg"), "user cover");
      mocks.download.mockImplementationOnce(async () => ({
        getSavePath: () => join(directory, "歌曲.mp3"),
      }));
      mocks.download.mockImplementationOnce(async (_win, _url, options: Options) => {
        if (!options.directory || !options.filename) throw new Error("missing cover destination");
        temporaryCover = options.directory;
        expect(temporaryCover).not.toBe(directory);
        await writeFile(join(temporaryCover, options.filename), "temporary cover");
        if (scenario === "cover failure") throw new Error("interrupted download");
        return { getSavePath: () => join(options.directory || "", options.filename || "") };
      });
      if (scenario === "metadata failure") {
        mocks.createFile.mockImplementation(() => {
          throw new Error("invalid audio metadata");
        });
      }
      expect(
        await invoke({
          downloadMeta: true,
          downloadCover: true,
          saveMetaFile: false,
          songData: { cover: "https://example.test/cover" },
        }),
      ).toEqual({ status: "success" });
      expect(temporaryCover).toBeDefined();
      await expect(access(temporaryCover || "")).rejects.toThrow();
      expect(await readFile(join(directory, "歌曲.jpg"), "utf8")).toBe("user cover");
      if (scenario !== "success") expect(mocks.warn).toHaveBeenCalled();
    },
  );

  it.each([
    ["艺\\术/家\u0000:曲?", "艺术家曲"],
    ["\\/\u0000", "未知文件名"],
  ])("在IPC边界清洗分隔符、NUL及无效文件名：%s", async (name, expected) => {
    expect(await invoke({ fileName: name, fileType: "m\\p\u00003" })).toEqual({
      status: "success",
    });
    expect(mocks.download.mock.calls[0][2].filename).toBe(`${expected}.mp3`);
    expect(await readFile(join(directory, `${expected}.mp3`), "utf8")).toBe("new audio");
  });
});
