import { afterEach, expect, it, vi } from "vitest";
import { watchEffect } from "vue";
import { FilesSession, filesSession } from "./filesSession";
import { localFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { ScanEntry } from "./mygo.bindings";

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
