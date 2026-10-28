import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMetadataSession, type LocalMetadataAccess } from "./localMetadataSession";
import type { LocalFileRef, MetadataResult, Patch } from "./mygo.bindings";

const ref: LocalFileRef = {
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "file",
  version: "one",
};
const renamedRef: LocalFileRef = { ...ref, fileId: "a".repeat(64), version: "b".repeat(64) };
const patch: Patch = {
  Title: "new",
  Artists: null,
  Album: null,
  AlbumArtists: null,
  Comment: null,
  Lyrics: null,
  Pictures: null,
};
const result = (overrides: Partial<MetadataResult> = {}): MetadataResult => ({
  code: "ok",
  committed: true,
  ref: renamedRef,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(save: LocalMetadataAccess["save"] = vi.fn(async () => result())) {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const refresh = vi.fn<() => Promise<void>>(async () => undefined);
  const access: LocalMetadataAccess = {
    current: () => true,
    read: vi.fn(async () => ({ code: "ok", committed: true, ref, sha256: "sha" })),
    save,
    cancel: vi.fn(async () => ({ code: "ok", committed: false })),
  };
  const session = new LocalMetadataSession({
    access: () => access,
    blockAudio: vi.fn(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    }),
    refreshLibrary: refresh,
  });
  return { access, session, releases, refresh };
}

afterEach(() => vi.useRealTimers());

describe("LocalMetadataSession", () => {
  it("keeps nil fields, accepts a valid renamed ref, and waits for refresh", async () => {
    const refreshGate = deferred<void>();
    const save = vi.fn(async () => result({ code: "saved_cleanup_required" }));
    const f = fixture(save);
    f.refresh.mockImplementation(() => refreshGate.promise);
    const pendingSave = f.session.save(ref, "sha", patch);
    await Promise.resolve();
    expect(f.access.save).toHaveBeenCalledWith(
      expect.objectContaining({ ref, sha256: "sha", patch }),
    );
    refreshGate.resolve();
    await expect(pendingSave).resolves.toMatchObject({ committed: true, refresh: "complete" });
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it("does not deduplicate a changed SHA or patch", async () => {
    const first = deferred<MetadataResult>();
    const f = fixture(vi.fn(() => first.promise));
    const one = f.session.save(ref, "sha-one", patch);
    const different = await f.session.save(ref, "sha-two", patch);
    expect(different.code).toBe("metadata_busy");
    await expect(
      f.session.save(ref, "sha-one", { ...patch, Title: "other" }),
    ).resolves.toMatchObject({ code: "metadata_busy" });
    expect(f.access.save).toHaveBeenCalledOnce();
    first.resolve(result());
    await one;
  });

  it("keeps one effect when timeout, late commit, and same-id reconcile overlap", async () => {
    vi.useFakeTimers();
    const original = deferred<MetadataResult>();
    const resync = deferred<MetadataResult>();
    const save = vi.fn().mockReturnValueOnce(original.promise).mockReturnValueOnce(resync.promise);
    const f = fixture(save);
    const first = f.session.save(ref, "sha", patch);
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(first).resolves.toMatchObject({ code: "pending" });
    const operationId = f.session.operation?.operationId;
    if (!operationId) throw new Error("missing operation id");
    const reconcile = f.session.reconcile(operationId);
    original.resolve(result());
    await expect(reconcile).resolves.toMatchObject({ committed: true, refresh: "complete" });
    resync.resolve(result());
    await Promise.resolve();
    expect(f.access.save).toHaveBeenCalledTimes(2);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
  });

  it("does not clear the fence for Cancel ok or invalid_operation", async () => {
    const saveGate = deferred<MetadataResult>();
    const f = fixture(vi.fn(() => saveGate.promise));
    const pendingSave = f.session.save(ref, "sha", patch);
    await Promise.resolve();
    vi.mocked(f.access.cancel).mockResolvedValueOnce({ code: "ok", committed: false });
    await f.session.cancel();
    expect(f.session.operation).toBeDefined();
    vi.mocked(f.access.cancel).mockResolvedValueOnce({
      code: "invalid_operation",
      committed: false,
    });
    await f.session.cancel();
    const id = f.session.operation?.operationId;
    if (!id) throw new Error("missing operation");
    await f.session.reconcile(id);
    expect(f.access.save).toHaveBeenCalledOnce();
    expect(f.releases[0]).not.toHaveBeenCalled();
    f.session.invalidate();
    expect(f.releases[0]).toHaveBeenCalledOnce();
    saveGate.resolve(result());
    await pendingSave;
  });

  it("invalidates the gate immediately and rejects a wrong read ref while accepting a renamed save ref", async () => {
    const f = fixture();
    f.access.read = vi.fn(async () => ({
      code: "ok",
      committed: true,
      ref: { ...ref, fileId: "wrong" },
      sha256: "sha",
    }));
    await expect(f.session.read(ref)).resolves.toMatchObject({
      code: "read_ref_conflict",
      committed: false,
    });
    const saveResult = await f.session.save(ref, "sha", patch);
    expect(saveResult.ref).toEqual(renamedRef);
    f.session.invalidate();
    expect(f.releases[0]).toHaveBeenCalledOnce();
  });

  it("does not claim library refresh when refresh rejects, while still exposing committed state", async () => {
    const f = fixture();
    f.refresh.mockRejectedValueOnce(new Error("rescan"));
    await expect(f.session.save(ref, "sha", patch)).resolves.toMatchObject({
      committed: true,
      refresh: "failed",
    });
  });
});

it("snapshots and freezes the entire request, matching stable deep patch contents", async () => {
  const gate = deferred<MetadataResult>();
  const nativeSave = vi.fn<LocalMetadataAccess["save"]>(() => gate.promise);
  const f = fixture(nativeSave);
  const editable: Patch = {
    ...patch,
    Artists: ["one"],
    Pictures: [{ MIME: "image/png", Data: "QQ==", Type: 3, Description: "cover" }],
  };
  const save = f.session.save(ref, "sha", editable);
  editable.Artists?.push("two");
  if (editable.Pictures?.[0]) editable.Pictures[0].Data = "Qg==";
  expect(nativeSave.mock.calls[0]?.[0]?.patch.Artists).toEqual(["one"]);
  expect(f.session.operation?.request.patch.Pictures?.[0]?.Data).toBe("QQ==");
  const same = f.session.save(ref, "sha", {
    ...patch,
    Pictures: [{ Description: "cover", Type: 3, Data: "QQ==", MIME: "image/png" }],
    Artists: ["one"],
  });
  expect(nativeSave).toHaveBeenCalledOnce();
  gate.resolve(result());
  await save;
  await same;
});

it("releases immediately on invalidate/dispose without awaiting native and ignores revoked late content", async () => {
  const native = deferred<MetadataResult>();
  const f = fixture(vi.fn(() => native.promise));
  const save = f.session.save(ref, "sha", patch);
  f.session.dispose();
  expect(f.access.cancel).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(f.releases[0]).toHaveBeenCalledOnce();
  await expect(save).resolves.toMatchObject({ code: "session_invalidated" });
  native.resolve(result());
  await Promise.resolve();
  expect(f.refresh).not.toHaveBeenCalled();
});

it("refreshes a committed error without ref and rejects cross-grant result as unresolved", async () => {
  const f = fixture(
    vi.fn(async () =>
      result({ code: "durability_uncertain", ref: undefined, recoveryName: "backup.mp3" }),
    ),
  );
  await expect(f.session.save(ref, "sha", patch)).resolves.toMatchObject({
    committed: true,
    refresh: "complete",
    recoveryName: "backup.mp3",
  });
  expect(f.refresh).toHaveBeenCalledOnce();
  const wrong = fixture(vi.fn(async () => result({ ref: { ...renamedRef, grantToken: "other" } })));
  await expect(wrong.session.save(ref, "sha", patch)).resolves.toMatchObject({
    code: "save_ref_conflict",
  });
  expect(wrong.session.operation).toBeDefined();
  expect(wrong.releases[0]).not.toHaveBeenCalled();
  wrong.session.invalidate();
});

it("bounds cancellation transport and disposal, observing late rejections", async () => {
  vi.useFakeTimers();
  const saveGate = deferred<MetadataResult>();
  const cancelGate = deferred<MetadataResult>();
  const f = fixture(vi.fn(() => saveGate.promise));
  f.access.cancel = vi.fn(() => cancelGate.promise);
  const save = f.session.save(ref, "sha", patch);
  const cancellation = f.session.cancel();
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(cancellation).resolves.toMatchObject({ code: "cancel_pending" });
  expect(f.session.operation).toBeDefined();
  f.session.dispose();
  await expect(save).resolves.toMatchObject({ code: "session_invalidated" });
  saveGate.reject(new Error("late save"));
  cancelGate.reject(new Error("late cancel"));
  await vi.runAllTimersAsync();
  expect(f.releases[0]).toHaveBeenCalledOnce();
});

it("turns synchronous access and gate errors into safe results", async () => {
  const session = new LocalMetadataSession({
    access: () => {
      throw new Error("access");
    },
    blockAudio: () => {
      throw new Error("gate");
    },
    refreshLibrary: async () => undefined,
  });
  await expect(session.read(ref)).resolves.toMatchObject({ code: "read_failed" });
  await expect(session.save(ref, "sha", patch)).resolves.toMatchObject({ committed: false });
  const f = fixture();
  const gateFailure = new LocalMetadataSession({
    access: () => f.access,
    blockAudio: () => {
      throw new Error("gate");
    },
    refreshLibrary: f.refresh,
  });
  await expect(gateFailure.save(ref, "sha", patch)).resolves.toMatchObject({ committed: false });
  expect(f.access.save).not.toHaveBeenCalled();
});
