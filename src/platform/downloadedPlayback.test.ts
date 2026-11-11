import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import type { LocalDownloadTask } from "./localDownloadSession";
import { resolveDownloadedPlayback, type DownloadedPlaybackOwner } from "./downloadedPlayback";

beforeEach(() => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const entry = localEntry();
  const song = { ...localSong(entry), id: "online", platform: "test", path: undefined };
  const task: LocalDownloadTask = {
    id: "download",
    filename: "song.mp3",
    label: "Song",
    quality: "320mp3",
    song: { id: song.id, platform: song.platform },
    target: { directory: "/Music", relativePath: entry.relativePath },
    phase: "success",
    done: true,
    committed: true,
    received: 20,
    total: 20,
    percent: 100,
    refresh: "complete",
    retryable: false,
  };
  const owner = {
    ready: shallowRef(true),
    directories: shallowRef([{ token: "grant", epoch: 7, displayPath: "/Music" }]),
    libraryEntries: [entry],
    downloads: { tasks: shallowRef([task]) },
  } satisfies DownloadedPlaybackOwner;
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  const resolve = (current = () => true, excluded: ReadonlySet<string> = new Set()) =>
    resolveDownloadedPlayback(song, "320mp3", "web-audio", owner, current, excluded, request);
  return { entry, song, task, owner, request, resolve };
}

describe("已下载文件取源", () => {
  it("只读取同歌曲同音质的有效文件，并保留在线身份", async () => {
    const f = fixture();
    const result = await f.resolve();
    expect(f.request).toHaveBeenCalledWith(
      expect.stringContaining("/__local/audio?"),
      expect.objectContaining({ method: "HEAD", credentials: "omit" }),
    );
    expect(result?.entry).toBe(f.entry);
    expect(result?.source).toMatchObject({ platform: "local", format: "mp3" });
    expect(f.song).toMatchObject({ id: "online", platform: "test", path: undefined });
    const mpv = await resolveDownloadedPlayback(
      f.song,
      "320mp3",
      "mpv",
      f.owner,
      () => true,
      new Set(),
      f.request,
    );
    expect(mpv?.source).toMatchObject({
      identity: "test:online",
      localRef: f.entry.ref,
      fileEpoch: 7,
    });
  });

  it("不同音质、未完成任务和失效授权不触发文件读取", async () => {
    const f = fixture();
    await expect(
      resolveDownloadedPlayback(
        f.song,
        "flac",
        "web-audio",
        f.owner,
        () => true,
        new Set(),
        f.request,
      ),
    ).resolves.toBeUndefined();
    f.owner.downloads!.tasks.value = [{ ...f.task, done: false }];
    expect(await f.resolve()).toBeUndefined();
    f.owner.downloads!.tasks.value = [f.task];
    f.owner.directories.value = [];
    expect(await f.resolve()).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("磁盘文件丢失或已失败的副本返回在线回退结果", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await f.resolve()).toBeUndefined();
    const result = await f.resolve();
    expect(result).toBeDefined();
    f.request.mockClear();
    expect(await f.resolve(() => true, new Set([result!.key]))).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("预检期间切歌或撤销目录不发布过期音源", async () => {
    const f = fixture();
    let current = true;
    f.request.mockImplementationOnce(async () => {
      current = false;
      return new Response(null, { status: 200 });
    });
    expect(await f.resolve(() => current)).toBeUndefined();
    f.request.mockImplementationOnce(async () => {
      f.owner.directories.value = [];
      return new Response(null, { status: 200 });
    });
    expect(await f.resolve()).toBeUndefined();
  });

  it("文件预检超时后停止等待，允许在线回退", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const result = f.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
