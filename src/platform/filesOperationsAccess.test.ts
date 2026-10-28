import { afterEach, expect, it, vi } from "vitest";
import { FilesSession } from "./filesSession";
import type { PlatformFiles } from "./files";
import type { DownloadOperation, DownloadState, MetadataResult, Patch } from "./mygo.bindings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const sessions: FilesSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});
const fileRef = { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "v1" };
const patch: Patch = {
  Title: "changed",
  Artists: null,
  Album: null,
  AlbumArtists: null,
  Comment: null,
  Lyrics: null,
  Pictures: null,
};
async function fixture() {
  const provider = {
    begin: vi.fn(async () => ({ epoch: 7 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      relation: "",
      existingToken: "",
      grant: { token: "grant", epoch: 7, displayPath: "/fixture" },
    })),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: vi.fn(async () => {}),
    readMetadata: vi.fn<NonNullable<PlatformFiles["readMetadata"]>>(async () => ({
      code: "ok",
      ref: fileRef,
      sha256: "hash",
      committed: false,
    })),
    saveMetadata: vi.fn<NonNullable<PlatformFiles["saveMetadata"]>>(async () => ({
      code: "ok",
      committed: true,
    })),
    cancelMetadata: vi.fn<NonNullable<PlatformFiles["cancelMetadata"]>>(async () => ({
      code: "ok",
      committed: false,
    })),
    startDownload: vi.fn<NonNullable<PlatformFiles["startDownload"]>>(async (_epoch, request) => ({
      operationId: request.operationId,
    })),
    readDownloadState: vi.fn<NonNullable<PlatformFiles["readDownloadState"]>>(),
    cancelDownload: vi.fn<NonNullable<PlatformFiles["cancelDownload"]>>(),
  } satisfies PlatformFiles;
  const files = new FilesSession(provider);
  sessions.push(files);
  expect(files.metadataAccess(fileRef)).toBeUndefined();
  expect(files.downloadAccess("grant")).toBeUndefined();
  await files.start();
  await files.chooseDirectory();
  return { files, provider };
}

it("captures a metadata target and refuses a mutated or foreign save target", async () => {
  const f = await fixture();
  const ref = { ...fileRef };
  const access = f.files.metadataAccess(ref);
  if (!access) throw new Error("Missing metadata access");
  ref.relativePath = "changed.mp3";
  await access.read();
  expect(f.provider.readMetadata).toHaveBeenCalledWith(7, fileRef);
  await expect(access.save({ operationId: "edit", ref, sha256: "hash", patch })).rejects.toThrow(
    "expired",
  );
  expect(f.provider.saveMetadata).not.toHaveBeenCalled();
  await access.save({ operationId: "edit", ref: fileRef, sha256: "hash", patch });
  expect(f.files.busy.value).toBe(false);
  expect(f.provider.saveMetadata).toHaveBeenCalledWith(7, {
    operationId: "edit",
    ref: fileRef,
    sha256: "hash",
    patch,
  });
});

it("strips a late metadata result after revocation while preserving whether disk commit occurred", async () => {
  const f = await fixture();
  const access = f.files.metadataAccess(fileRef);
  if (!access) throw new Error("Missing metadata access");
  const pending = deferred<MetadataResult>();
  f.provider.saveMetadata.mockReturnValueOnce(pending.promise);
  const saving = access.save({ operationId: "edit", ref: fileRef, sha256: "hash", patch });
  await f.files.revokeDirectory("grant");
  pending.resolve({
    code: "ok",
    committed: true,
    ref: { ...fileRef, fileId: "new", version: "v2" },
    sha256: "new-hash",
    recoveryName: "backup",
    residualNames: ["work"],
  });
  await expect(saving).resolves.toEqual({ code: "revoked", committed: true });
  expect(access.current()).toBe(false);
  await access.cancel("edit");
  expect(f.provider.cancelMetadata).toHaveBeenCalledWith(7, "edit");
});

it("cancels the requested late download ID with its captured epoch after grant loss", async () => {
  const f = await fixture();
  const access = f.files.downloadAccess("grant");
  if (!access) throw new Error("Missing download access");
  const pending = deferred<DownloadOperation>();
  f.provider.startDownload.mockReturnValueOnce(pending.promise);
  f.provider.cancelDownload.mockResolvedValue({
    operationId: "download",
    code: "revoked",
    done: true,
    received: 0,
    total: 0,
    committed: false,
  });
  const request = {
    operationId: "download",
    grantToken: "grant",
    filename: "song.mp3",
    url: "https://fixture.test/song",
  };
  const starting = access.start(request);
  request.operationId = "mutated-id";
  const failure = expect(starting).rejects.toThrow("expired");
  await f.files.revokeDirectory("grant");
  pending.resolve({ operationId: "unexpected-id" });
  await failure;
  expect(f.provider.startDownload.mock.calls[0]?.[1].operationId).toBe("download");
  expect(f.provider.cancelDownload).toHaveBeenCalledWith(7, "download");
  expect(f.provider.cancelDownload).not.toHaveBeenCalledWith(7, "unexpected-id");
});

it("rejects cross-grant starts and drops late download states after disposal", async () => {
  const f = await fixture();
  const access = f.files.downloadAccess("grant");
  if (!access) throw new Error("Missing download access");
  await expect(
    access.start({
      operationId: "download",
      grantToken: "foreign",
      filename: "song.mp3",
      url: "https://fixture.test/song",
    }),
  ).rejects.toThrow("expired");
  expect(f.provider.startDownload).not.toHaveBeenCalled();
  const pending = deferred<DownloadState>();
  f.provider.readDownloadState.mockReturnValueOnce(pending.promise);
  const reading = access.read("download");
  const failure = expect(reading).rejects.toThrow("expired");
  await f.files.dispose();
  pending.resolve({
    operationId: "download",
    code: "ok",
    done: true,
    received: 10,
    total: 10,
    committed: true,
    ref: fileRef,
  });
  await failure;
  expect(f.files.downloadAccess("grant")).toBeUndefined();
});
