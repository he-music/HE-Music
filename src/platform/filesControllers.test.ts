import { afterEach, expect, it, vi } from "vitest";
import { FilesSession } from "./filesSession";
import { localFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { MetadataResult, Patch, ScanEntry, ScanPage } from "./mygo.bindings";

const sources: FilesSession[] = [];
afterEach(async () => {
  for (const source of sources.splice(0).reverse()) await source.dispose();
});
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ref = {
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "a".repeat(64),
  version: "b".repeat(64),
};
const info: ScanEntry["metadata"] = {
  Container: "MP3",
  Title: "old",
  Artists: [],
  Album: "",
  AlbumArtists: [],
  Comment: "",
  Lyrics: "",
  Pictures: [],
  PicturesLoaded: false,
  DurationSeconds: 1,
  BitrateKbps: 128,
  SampleRateHz: 44100,
  Channels: 2,
  BitsPerSample: 0,
  Codec: "MPEG",
};
const entry: ScanEntry = {
  ref,
  relativePath: ref.relativePath,
  filename: "song.mp3",
  size: 10,
  metadata: info,
};
const newRef = { ...ref, fileId: "c".repeat(64), version: "d".repeat(64) };
const patch: Patch = {
  Title: "new",
  Artists: null,
  Album: null,
  AlbumArtists: null,
  Comment: null,
  Lyrics: null,
  Pictures: null,
};
async function fixture() {
  let job = 0;
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 7 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 7, displayPath: "/fixture" },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: `scan-${++job}` })),
    readScanPage: vi.fn(async (_epoch, operationId) => ({
      operationId,
      nextCursor: "1",
      done: true,
      issues: [],
      entries: [entry],
    })),
    cancelFileOperation: vi.fn(async () => {}),
    readMetadata: vi.fn(async () => ({
      code: "ok",
      committed: false,
      ref,
      info,
      sha256: "e".repeat(64),
    })),
    saveMetadata: vi.fn(async () => ({ code: "ok", committed: true, ref: newRef })),
    cancelMetadata: vi.fn(async () => ({ code: "ok", committed: false })),
  };
  const release = vi.fn();
  const blockAudio = vi.fn(() => release);
  const owner = new FilesSession(provider, { blockAudio });
  sources.push(owner);
  await owner.start();
  await owner.chooseDirectory();
  const local = localFilesSession.value;
  const metadata = owner.metadata;
  if (!local || !metadata) throw new Error("Missing fixture controllers");
  return { owner, local, metadata, provider, release, blockAudio };
}

it("clears old refs before refresh and holds the audio gate until refresh completes", async () => {
  const f = await fixture();
  await f.local.scan();
  const page = deferred<ScanPage>();
  vi.mocked(f.provider.readScanPage!).mockReturnValueOnce(page.promise);
  const saving = f.metadata.save(ref, "e".repeat(64), patch);
  await flush();
  expect(f.local.entries.value).toEqual([]);
  expect(f.release).not.toHaveBeenCalled();
  page.resolve({
    operationId: "scan-2",
    nextCursor: "1",
    done: true,
    issues: [],
    entries: [{ ...entry, ref: newRef }],
  });
  expect((await saving).refresh).toBe("complete");
  expect(f.local.entries.value[0]?.ref).toEqual(newRef);
  expect(f.release).toHaveBeenCalledOnce();
});

it("preserves committed truth when the library refresh fails", async () => {
  const f = await fixture();
  vi.mocked(f.provider.startScan!).mockRejectedValueOnce(new Error("fixture scan failure"));
  const result = await f.metadata.save(ref, "e".repeat(64), patch);
  expect(result.committed).toBe(true);
  expect(result.refresh).toBe("failed");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.metadata.operation).toBeUndefined();
});

it("keeps an unrelated grant change out of the active save and retires only its own grant", async () => {
  const f = await fixture();
  const response = deferred<MetadataResult>();
  vi.mocked(f.provider.saveMetadata!).mockReturnValueOnce(response.promise);
  const saving = f.metadata.save(ref, "e".repeat(64), patch);
  const id = f.metadata.operation?.operationId;
  vi.mocked(f.provider.chooseDirectory).mockResolvedValueOnce({
    status: "selected",
    grant: { token: "other", epoch: 7, displayPath: "/other" },
    relation: "",
    existingToken: "",
  });
  await f.owner.chooseDirectory();
  await f.owner.revokeDirectory("other");
  expect(f.metadata.operation?.operationId).toBe(id);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.provider.cancelMetadata).not.toHaveBeenCalled();
  await f.owner.revokeDirectory("grant");
  expect(f.metadata.operation).toBeUndefined();
  expect(f.release).toHaveBeenCalledOnce();
  expect((await saving).code).toBe("session_invalidated");
  response.resolve({ code: "ok", committed: true, ref: newRef });
  await flush();
  expect(f.provider.startScan).not.toHaveBeenCalled();
});

it("disposes the metadata owner with its captured epoch and never refreshes on late completion", async () => {
  const f = await fixture();
  const response = deferred<MetadataResult>();
  vi.mocked(f.provider.saveMetadata!).mockReturnValueOnce(response.promise);
  const saving = f.metadata.save(ref, "e".repeat(64), patch);
  const id = f.metadata.operation?.operationId;
  await f.owner.dispose();
  await saving;
  expect(f.provider.cancelMetadata).toHaveBeenCalledWith(7, id);
  expect(f.release).toHaveBeenCalledOnce();
  response.resolve({ code: "ok", committed: true, ref: newRef });
  await flush();
  expect(f.provider.startScan).not.toHaveBeenCalled();
});
