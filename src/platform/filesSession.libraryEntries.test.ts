import { afterEach, expect, it, vi } from "vitest";
import { computed, shallowRef, watchEffect } from "vue";
import { FilesSession, filesSession } from "./filesSession";
import { localFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { ScanEntry } from "./mygo.bindings";
import { useMygoDownloadedSongs } from "@/composables/mygoDownloadedSongs";

const entry: ScanEntry = {
  ref: { grantToken: "grant", fileId: "fresh", version: "v1", relativePath: "Song.mp3" },
  relativePath: "Song.mp3",
  filename: "Song.mp3",
  size: 10,
  metadata: {
    Container: "MP3",
    Title: "Song",
    Artists: ["Artist"],
    Album: "Album",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    Pictures: [],
    PicturesLoaded: false,
    DurationSeconds: 10,
    BitrateKbps: 128,
    SampleRateHz: 44100,
    Channels: 2,
    BitsPerSample: 16,
    Codec: "MP3",
  },
};

afterEach(async () => {
  await filesSession.value?.dispose();
});

it("makes a committed MP3 playable before the directory scan finishes, even with unrelated scan warnings", async () => {
  let finishScan!: (value: import("./mygo.bindings").ScanPage) => void;
  const scanning = new Promise<import("./mygo.bindings").ScanPage>((resolve) => {
    finishScan = resolve;
  });
  const native: PlatformFiles = {
    begin: async () => ({ epoch: 1 }),
    chooseDirectory: async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/Music" },
      relation: "",
      existingToken: "",
    }),
    revokeDirectory: async () => {},
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: async () => {},
    startScan: async () => ({ operationId: "scan" }),
    readScanPage: async () => scanning,
    cancelFileOperation: async () => {},
    startDownload: async (_epoch, request) => ({ operationId: request.operationId }),
    readDownloadState: async (_epoch, id) => ({
      operationId: id,
      filename: "Song.mp3",
      code: "ok",
      done: true,
      committed: true,
      received: 10,
      total: 10,
      ref: entry.ref,
    }),
    cancelDownload: vi.fn(),
  };
  const owner = new FilesSession(native);
  await owner.start();
  await owner.chooseDirectory();
  const downloads = owner.downloads!;
  const id = await downloads.start({
    grantToken: "grant",
    filename: "Song.mp3",
    label: "Song",
    quality: "320mp3",
    source: {
      id: "online",
      platform: "provider",
      name: "Song",
      links: [{ name: "320mp3", format: "mp3", quality: 320, size: "10" }],
    },
    resolveURL: async () => ({ url: "https://example.test/song.mp3", format: "mp3" }),
    url: "https://example.test/song.mp3",
  });
  await downloads.refresh(id!);
  for (let n = 0; n < 15; n++) await Promise.resolve();
  const view = useMygoDownloadedSongs(
    shallowRef(owner),
    computed(() => downloads.tasks.value),
  );
  expect(localFilesSession.value?.scanning.value).toBe(true);
  expect(view.files.value.has(id!)).toBe(true);
  expect(owner.libraryEntries[0].ref).toEqual(entry.ref);
  finishScan({
    operationId: "scan",
    entries: [],
    issues: [{ relativePath: "shortcut", code: "symlink" }],
    nextCursor: "1",
    done: true,
  });
  for (let n = 0; n < 30; n++) await Promise.resolve();
  expect(view.files.value.has(id!)).toBe(true);
  expect(downloads.tasks.value[0].committed).toBe(true);
  await owner.revokeDirectory("grant");
  expect(view.files.value.size).toBe(0);
});

it("publishes reactive read-only scan entries after owner initialization, rescan and revoke", async () => {
  const native: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/Music" },
      relation: "",
      existingToken: "",
    })),
    revokeDirectory: vi.fn(async () => {}),
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: "scan" })),
    readScanPage: vi.fn(async () => ({
      operationId: "scan",
      entries: [entry],
      issues: [],
      nextCursor: "1",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
  };
  const session = new FilesSession(native);
  let observed: readonly ScanEntry[] = [];
  const stop = watchEffect(
    () => {
      observed = session.libraryEntries;
    },
    { flush: "sync" },
  );
  try {
    expect(observed).toEqual([]);
    await session.start();
    await session.chooseDirectory();
    await localFilesSession.value?.scan();
    expect(observed).toEqual([entry]);
    expect(observed).toBe(session.libraryEntries);
    const readPage = native.readScanPage;
    if (!readPage) throw new Error("Missing scan provider");
    const refreshed = { ...entry, metadata: { ...entry.metadata, Title: "Updated" } };
    vi.mocked(readPage).mockResolvedValueOnce({
      operationId: "scan",
      entries: [refreshed],
      issues: [],
      nextCursor: "1",
      done: true,
    });
    await localFilesSession.value?.scan();
    expect(observed).toEqual([refreshed]);
    await session.revokeDirectory("grant");
    expect(observed).toEqual([]);
    await session.dispose();
    expect(observed).toEqual([]);
  } finally {
    stop();
    await session.dispose();
  }
});
