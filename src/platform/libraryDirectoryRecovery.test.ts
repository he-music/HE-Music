import { effectScope, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesSession } from "./filesSession";
import { localFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { DirectorySelection } from "./mygo.bindings";
import { createLibraryDirectoryRecovery } from "./libraryDirectoryRecovery";

const owners: FilesSession[] = [];
const scopes: ReturnType<typeof effectScope>[] = [];
function provider(): PlatformFiles {
  return {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn(async (): Promise<DirectorySelection> => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/fixture/music" },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    startScan: vi.fn(async () => ({ operationId: "scan" })),
    readScanPage: vi.fn(async () => ({
      operationId: "scan",
      entries: [],
      issues: [],
      nextCursor: "done",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
  };
}
async function setup(saved = ["/fixture/music"]) {
  const native = provider();
  const owner = new FilesSession(native);
  owners.push(owner);
  await owner.start();
  const current = shallowRef<FilesSession | undefined>(owner);
  const paths = shallowRef(saved);
  const write = vi.fn((value: string[]) => (paths.value = value));
  const scope = effectScope();
  scopes.push(scope);
  const recovery = scope.run(() =>
    createLibraryDirectoryRecovery({ read: () => paths.value, write }, current),
  );
  if (!recovery) throw new Error("Missing recovery scope");
  return { native, owner, current, paths, write, recovery };
}
afterEach(async () => {
  scopes.splice(0).forEach((scope) => scope.stop());
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
});

describe("libraryDirectoryRecovery", () => {
  it("restart keeps only display hints; a real selection scans exactly once and deduplicates", async () => {
    const { recovery, native, paths, write, owner } = await setup();
    expect(recovery.pendingPaths.value).toEqual(["/fixture/music"]);
    expect(owner.directories.value).toEqual([]);
    expect(native.chooseDirectory).not.toHaveBeenCalled();
    expect(native.startScan).not.toHaveBeenCalled();
    await recovery.choose();
    expect(recovery.pendingPaths.value).toEqual([]);
    expect(paths.value).toEqual(["/fixture/music"]);
    expect(write).toHaveBeenCalledOnce();
    expect(native.startScan).toHaveBeenCalledExactlyOnceWith(1, "grant");
    await recovery.choose();
    expect(native.startScan).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    await owner.revokeDirectory("grant");
    expect(recovery.pendingPaths.value).toEqual(["/fixture/music"]);
  });

  it("cancelled, failed and old owner late selections cannot save or scan the replacement", async () => {
    const { recovery, native, current, write, owner } = await setup();
    vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
      status: "cancelled",
      grant: null,
      relation: "",
      existingToken: "",
    });
    await recovery.choose();
    vi.mocked(native.chooseDirectory).mockRejectedValueOnce(new Error("picker failed"));
    await recovery.choose();
    let resolve: ((selection: DirectorySelection) => void) | undefined;
    vi.mocked(native.chooseDirectory).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const choosing = recovery.choose();
    await owner.dispose();
    const replacement = new FilesSession(provider());
    owners.push(replacement);
    await replacement.start();
    const replacementLibrary = localFilesSession.value;
    if (!replacementLibrary) throw new Error("Missing replacement library");
    const scan = vi.spyOn(replacementLibrary, "scan");
    current.value = replacement;
    resolve?.({
      status: "selected",
      grant: { token: "late", epoch: 1, displayPath: "/fixture/late" },
      relation: "",
      existingToken: "",
    });
    await choosing;
    expect(write).not.toHaveBeenCalled();
    expect(native.startScan).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(replacement.directories.value).toEqual([]);
  });

  it("new selections retain other grants and hints; only display strings are persisted", async () => {
    const { recovery, native, paths, owner } = await setup(["/fixture/imported"]);
    await recovery.choose();
    vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
      status: "selected",
      grant: { token: "second", epoch: 1, displayPath: "/fixture/second" },
      relation: "",
      existingToken: "",
    });
    await recovery.choose();
    expect(owner.directories.value.map((grant) => grant.token)).toEqual(["grant", "second"]);
    expect(paths.value).toEqual(["/fixture/imported", "/fixture/music", "/fixture/second"]);
    expect(native.startScan).toHaveBeenCalledTimes(3);
    await owner.revokeDirectory("second");
    expect(owner.directories.value.map((grant) => grant.token)).toEqual(["grant"]);
    expect(recovery.pendingPaths.value).toEqual(["/fixture/imported", "/fixture/second"]);
  });
});

it("a new directory scan cancels earlier work without revoking other grants", async () => {
  const { recovery, native, owner, write } = await setup();
  await recovery.choose();
  const library = localFilesSession.value;
  if (!library || !native.readScanPage) throw new Error("Missing scanning support");
  let finishPage: (() => void) | undefined;
  vi.mocked(native.readScanPage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = () =>
          resolve({ operationId: "scan", entries: [], issues: [], nextCursor: "done", done: true });
      }),
  );
  const earlier = library.scan();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
    status: "selected",
    grant: { token: "second", epoch: 1, displayPath: "/fixture/second" },
    relation: "",
    existingToken: "",
  });
  await recovery.choose();
  finishPage?.();
  await earlier;
  expect(native.cancelFileOperation).toHaveBeenCalled();
  expect(native.revokeDirectory).not.toHaveBeenCalled();
  expect(owner.directories.value.map((grant) => grant.token)).toEqual(["grant", "second"]);
  expect(library.phase.value).toBe("complete");
  expect(write).toHaveBeenCalledTimes(2);
});

it("an in-flight picker rejects concurrent selection without another scan or hint update", async () => {
  const { recovery, native, write } = await setup();
  let finish: ((value: DirectorySelection) => void) | undefined;
  vi.mocked(native.chooseDirectory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = recovery.choose();
  expect(await recovery.choose()).toEqual({ status: "busy" });
  finish?.({
    status: "selected",
    grant: { token: "grant", epoch: 1, displayPath: "/fixture/music" },
    relation: "",
    existingToken: "",
  });
  await first;
  expect(native.chooseDirectory).toHaveBeenCalledOnce();
  expect(native.startScan).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledOnce();
});
