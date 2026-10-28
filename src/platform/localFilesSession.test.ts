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
});
