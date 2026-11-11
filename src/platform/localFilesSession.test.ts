import { afterEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { FilesSession } from "./filesSession";
import { LocalFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { ScanEntry, ScanPage } from "./mygo.bindings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function entry(): ScanEntry {
  return {
    ref: { grantToken: "grant", fileId: "file", version: "version", relativePath: "music.mp3" },
    relativePath: "music.mp3",
    filename: "music.mp3",
    size: 10,
    metadata: {
      Container: "MP3",
      Title: "临时歌曲",
      Artists: ["艺人"],
      Album: "专辑",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      DurationSeconds: 2,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 0,
      Codec: "MPEG",
    },
  };
}

function page(entries: ScanEntry[] = [entry()]): ScanPage {
  return { operationId: "job", entries, issues: [], nextCursor: "1", done: true };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function fixture() {
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 7 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 7, displayPath: "/test-only" },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: "job" })),
    readScanPage: vi.fn(async () => page()),
    cancelFileOperation: vi.fn(async () => {}),
  };
  const shell = new FilesSession(provider);
  await shell.start();
  await shell.chooseDirectory();
  const source = shallowRef<FilesSession | undefined>(shell);
  const local = new LocalFilesSession(source);
  cleanups.push(
    () => shell.dispose(),
    () => local.dispose(),
  );
  return { provider, shell, source, local };
}

async function flush() {
  for (let n = 0; n < 15; n++) await Promise.resolve();
}

describe("LocalFilesSession", () => {
  it("publishes a native-confirmed download immediately and retains it across partial scans", async () => {
    const f = await fixture();
    const file = entry();
    f.local.publishDownloadedFile(file);
    expect(f.local.entries.value).toEqual([file]);
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce({
      ...page([]),
      issues: [{ relativePath: "shortcut", code: "symlink" }],
    });
    await f.local.scan();
    expect(f.local.phase.value).toBe("partial");
    expect(f.local.entries.value).toEqual([file]);
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce(page([]));
    await f.local.scan();
    expect(f.local.entries.value).toEqual([]);
  });
  it("keeps a newly committed file when a scan started before the commit finishes later", async () => {
    const f = await fixture();
    const pending = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(pending.promise);
    const scanning = f.local.scan();
    await flush();
    const file = entry();
    f.local.publishDownloadedFile(file);
    pending.resolve(page([]));
    await scanning;
    expect(f.local.entries.value).toEqual([file]);
    await f.shell.revokeDirectory("grant");
    f.local.publishDownloadedFile(file);
    expect(f.local.entries.value).toEqual([]);
  });
  it("rejects foreign or mismatched download references and clears seeded files before deletion refresh", async () => {
    const f = await fixture();
    f.local.publishDownloadedFile({ ...entry(), ref: { ...entry().ref, grantToken: "foreign" } });
    f.local.publishDownloadedFile({ ...entry(), relativePath: "different.mp3" });
    expect(f.local.entries.value).toEqual([]);
    f.local.publishDownloadedFile(entry());
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce({
      ...page([]),
      issues: [{ relativePath: "shortcut", code: "symlink" }],
    });
    await f.local.refreshAfterWrite();
    expect(f.local.entries.value).toEqual([]);
  });
  it("clears obsolete references before refreshing after a write and rejects an older scan page", async () => {
    const f = await fixture();
    await f.local.scan();
    const oldPage = deferred<ScanPage>();
    const newPage = deferred<ScanPage>();
    vi.mocked(f.provider.startScan!)
      .mockResolvedValueOnce({ operationId: "old" })
      .mockResolvedValueOnce({ operationId: "new" });
    vi.mocked(f.provider.readScanPage!)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const olderScan = f.local.scan();
    await flush();
    const refreshing = f.local.refreshAfterWrite();
    expect(f.local.entries.value).toEqual([]);
    await flush();
    oldPage.resolve({ ...page(), operationId: "old" });
    await olderScan;
    expect(f.local.entries.value).toEqual([]);
    const updated = entry();
    updated.ref = { ...updated.ref, fileId: "new-file", version: "new-version" };
    updated.metadata.Title = "已保存";
    newPage.resolve({ ...page([updated]), operationId: "new" });
    await refreshing;
    expect(f.local.entries.value).toEqual([updated]);
    expect(f.provider.cancelFileOperation).toHaveBeenCalledWith(7, "old");
  });
  it("scans current grants without occupying the picker slot and drops results on revoke", async () => {
    const f = await fixture();
    const pending = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(pending.promise);
    const running = f.local.scan();
    await flush();
    expect(f.shell.busy.value).toBe(false);
    expect(f.local.scanning.value).toBe(true);
    pending.resolve(page());
    await running;
    expect(f.provider.startScan).toHaveBeenCalledExactlyOnceWith(7, "grant");
    expect(f.local.entries.value).toEqual([entry()]);
    expect(f.local.phase.value).toBe("complete");
    await f.shell.revokeDirectory("grant");
    expect(f.local.entries.value).toEqual([]);
    expect(f.shell.scanAccess("grant")).toBeUndefined();
  });

  it("cancels an operation arriving after disposal and never publishes it", async () => {
    const f = await fixture();
    const starting = deferred<{ operationId: string }>();
    vi.mocked(f.provider.startScan!).mockReturnValueOnce(starting.promise);
    const running = f.local.scan();
    f.local.dispose();
    starting.resolve({ operationId: "job" });
    await running;
    expect(f.provider.cancelFileOperation).toHaveBeenCalledWith(7, "job");
    expect(f.provider.readScanPage).not.toHaveBeenCalled();
    expect(f.local.entries.value).toEqual([]);
  });

  it("rejects late pages after grant removal or shell replacement", async () => {
    const f = await fixture();
    const pending = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(pending.promise);
    const running = f.local.scan();
    await flush();
    await f.shell.revokeDirectory("grant");
    pending.resolve(page());
    await running;
    expect(f.local.entries.value).toEqual([]);
    expect(f.provider.cancelFileOperation).toHaveBeenCalledWith(7, "job");
  });

  it("polls empty pages with a disposable timer and reports limits as partial", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    vi.mocked(f.provider.readScanPage!)
      .mockResolvedValueOnce({ ...page([]), done: false })
      .mockResolvedValueOnce({
        ...page(),
        nextCursor: "2",
        issues: [{ relativePath: "", code: "item-limit" }],
      });
    const running = f.local.scan();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    await running;
    expect(f.provider.readScanPage).toHaveBeenLastCalledWith(7, "job", "1");
    expect(f.local.phase.value).toBe("partial");
    expect(f.local.issues.value[0]?.code).toBe("item-limit");
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(f.provider.readScanPage!).mockResolvedValue({ ...page([]), done: false });
    const cancelled = f.local.scan();
    await flush();
    f.local.cancel();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shell disposal cleans up late StartScan replies by their captured epoch", async () => {
    const f = await fixture();
    const starting = deferred<{ operationId: string }>();
    vi.mocked(f.provider.startScan!).mockReturnValueOnce(starting.promise);
    const running = f.local.scan();
    await f.shell.dispose();
    starting.resolve({ operationId: "late" });
    await running;
    expect(f.provider.cancelFileOperation).toHaveBeenCalledWith(7, "late");
    expect(f.local.phase.value).toBe("idle");
    expect(f.local.entries.value).toEqual([]);
  });
  it("replacing the shell drops old results and ignores its pending page", async () => {
    const f = await fixture();
    await f.local.scan();
    const pending = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(pending.promise);
    const running = f.local.scan();
    await flush();
    f.source.value = undefined;
    expect(f.local.entries.value).toEqual([]);
    pending.resolve(page());
    await running;
    expect(f.local.entries.value).toEqual([]);
    expect(f.local.phase.value).toBe("idle");
  });

  it("contains RPC failures and rejects a foreign grant in page results", async () => {
    const f = await fixture();
    const foreign = entry();
    foreign.ref.grantToken = "foreign";
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce(page([foreign]));
    await f.local.scan();
    expect(f.local.phase.value).toBe("failed");
    expect(f.local.entries.value).toEqual([]);
    expect(f.provider.cancelFileOperation).toHaveBeenCalledWith(7, "job");
    vi.mocked(f.provider.startScan!).mockRejectedValueOnce(new Error("private native detail"));
    await expect(f.local.scan()).resolves.toBeUndefined();
    expect(f.local.phase.value).toBe("failed");
  });
  it("bounds a post-write refresh and discards its late scan page", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const pending = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(pending.promise);
    const refresh = f.local.refreshAfterWrite();
    const failure = expect(refresh).rejects.toThrow("Library refresh timed out");
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    await failure;
    expect(f.local.phase.value).toBe("failed");
    expect(f.local.entries.value).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(page());
    await flush();
    expect(f.local.phase.value).toBe("failed");
    expect(f.local.entries.value).toEqual([]);
  });

  it("clears the refresh deadline when a newer scan replaces it", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const oldPage = deferred<ScanPage>();
    const newPage = deferred<ScanPage>();
    vi.mocked(f.provider.startScan!)
      .mockResolvedValueOnce({ operationId: "old" })
      .mockResolvedValueOnce({ operationId: "new" });
    vi.mocked(f.provider.readScanPage!)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const refresh = f.local.refreshAfterWrite();
    const failure = expect(refresh).rejects.toThrow("Library refresh cancelled");
    await flush();
    const newer = f.local.scan();
    await flush();
    await failure;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.local.scanning.value).toBe(true);
    expect(f.provider.cancelFileOperation).not.toHaveBeenCalledWith(7, "new");
    newPage.resolve({ ...page(), operationId: "new" });
    await newer;
    oldPage.resolve({ ...page(), operationId: "old" });
    await flush();
    expect(f.local.phase.value).toBe("complete");
    expect(f.local.entries.value).toHaveLength(1);
  });

  it("coalesces simultaneous download refreshes and scans again for a later commit", async () => {
    const f = await fixture();
    const firstPage = deferred<ScanPage>();
    const lastPage = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!)
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(lastPage.promise);
    const first = f.local.refreshAfterDownload();
    await flush();
    const second = f.local.refreshAfterDownload();
    expect(second).toBe(first);
    firstPage.resolve(page());
    await flush();
    expect(f.provider.startScan).toHaveBeenCalledTimes(2);
    const downloaded = {
      ...entry(),
      ref: { ...entry().ref, fileId: "downloaded", relativePath: "downloaded.mp3" },
      relativePath: "downloaded.mp3",
      filename: "downloaded.mp3",
    };
    lastPage.resolve(page([entry(), downloaded]));
    await Promise.all([first, second]);
    expect(f.local.entries.value).toEqual([entry(), downloaded]);
    expect(f.local.phase.value).toBe("complete");
    expect(f.provider.cancelFileOperation).not.toHaveBeenCalled();
  });
  it("refreshes only the committed download directory and preserves the other directory's songs", async () => {
    const f = await fixture();
    vi.mocked(f.provider.chooseDirectory).mockResolvedValueOnce({
      status: "selected",
      grant: { token: "other", epoch: 7, displayPath: "/other" },
      relation: "",
      existingToken: "",
    });
    await f.shell.chooseDirectory();
    const other = {
      ...entry(),
      ref: { ...entry().ref, grantToken: "other", fileId: "other-file" },
    };
    vi.mocked(f.provider.startScan!).mockImplementation(async (_epoch, token) => ({
      operationId: token,
    }));
    vi.mocked(f.provider.readScanPage!).mockImplementation(async (_epoch, id) => ({
      ...page([id === "grant" ? entry() : other]),
      operationId: id,
    }));
    await f.local.scan();
    expect(f.local.entries.value).toHaveLength(2);
    vi.mocked(f.provider.startScan!).mockClear();
    vi.mocked(f.provider.startScan!).mockImplementation(async (_epoch, token) => {
      if (token !== "grant") throw new Error("unrelated directory unavailable");
      return { operationId: token };
    });
    await f.local.refreshAfterDownload("grant");
    expect(f.provider.startScan).toHaveBeenCalledExactlyOnceWith(7, "grant");
    expect(f.local.entries.value).toContain(other);
    expect(f.local.phase.value).toBe("complete");
    await expect(f.local.refreshAfterDownload("revoked")).rejects.toThrow(
      "Download directory unavailable",
    );
  });
  it("自动同步复用未变化条目，仅发布新增、修改或删除", async () => {
    const f = await fixture();
    await f.local.scan();
    const first = f.local.entries.value;
    await f.local.refreshWhenIdle(new AbortController().signal);
    expect(f.local.entries.value).toBe(first);
    expect(f.local.syncing.value).toBe(false);
    const added = {
      ...entry(),
      filename: "added.mp3",
      relativePath: "added.mp3",
      ref: { ...entry().ref, fileId: "added", relativePath: "added.mp3" },
    };
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce(page([entry(), added]));
    await f.local.refreshWhenIdle(new AbortController().signal);
    expect(f.local.entries.value).toHaveLength(2);
    expect(f.local.entries.value[0]).toBe(first[0]);
    const changed = entry();
    changed.metadata.Title = "已修改";
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce(page([changed]));
    await f.local.refreshWhenIdle(new AbortController().signal);
    expect(f.local.entries.value).not.toBe(first);
    expect(f.local.entries.value[0].metadata.Title).toBe("已修改");
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce(page([]));
    await f.local.refreshWhenIdle(new AbortController().signal);
    expect(f.local.entries.value).toEqual([]);
  });

  it("取消自动同步不会取消后来发起的手动扫描", async () => {
    const f = await fixture();
    const oldPage = deferred<ScanPage>();
    const manualPage = deferred<ScanPage>();
    vi.mocked(f.provider.readScanPage!)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(manualPage.promise);
    const controller = new AbortController();
    const automatic = f.local.refreshWhenIdle(controller.signal);
    await flush();
    expect(f.local.syncing.value).toBe(true);
    const manual = f.local.scan();
    await flush();
    controller.abort();
    oldPage.resolve(page([]));
    await automatic;
    expect(f.local.scanning.value).toBe(true);
    expect(f.local.syncing.value).toBe(false);
    manualPage.resolve(page());
    await manual;
    expect(f.local.entries.value).toHaveLength(1);
  });
});
