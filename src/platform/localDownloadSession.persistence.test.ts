import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDownloadSession, validDownloadFilename } from "./localDownloadSession";
import { LOCAL_DOWNLOAD_FORMATS, type LocalDownloadSnapshot } from "./localDownloadPersistence";

const snapshot = (
  id = "old",
  extra: Partial<LocalDownloadSnapshot> = {},
): LocalDownloadSnapshot => ({
  id,
  label: "Song",
  filename: "song.mp3",
  quality: "320",
  source: {
    id: "song",
    platform: "test",
    name: "Song",
    links: [{ name: "320", quality: 320, format: "mp3" }],
  },
  targetDirectory: "/Music",
  phase: "active",
  done: false,
  committed: false,
  received: 0,
  total: 0,
  ...extra,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const sessions: LocalDownloadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
});
function setup(history: LocalDownloadSnapshot[] | Promise<LocalDownloadSnapshot[]> = [snapshot()]) {
  const persistence = {
    load: vi.fn(async () => history),
    save: vi.fn<(snapshots: readonly LocalDownloadSnapshot[]) => Promise<void>>(async () => {}),
  };
  const access = {
    current: vi.fn(() => true),
    start: vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
    })),
    read: vi.fn(async (id: string) => ({
      operationId: id,
      code: "running",
      done: false,
      committed: false,
      received: 2 ** 40,
      total: 2 ** 41,
    })),
    cancel: vi.fn(async (id: string) => ({
      operationId: id,
      code: "cancelled",
      done: true,
      committed: false,
      received: 0,
      total: 0,
    })),
  };
  const resolveURL = vi.fn(async () => ({
    url: "https://example.test/NEW_SIGNED",
    format: "mp3",
  }));
  const deps = {
    persistence,
    access: vi.fn((token: string) => (token === "new-grant" ? access : undefined)),
    onCommitted: async () => {},
    directoryPath: () => "/Music",
    directoryToken: vi.fn((): string | undefined => "new-grant"),
    resolveURL,
  };
  const session = new LocalDownloadSession(deps);
  sessions.push(session);
  return { session, persistence, access, deps, resolveURL };
}
const input = {
  grantToken: "new-grant",
  filename: "new.mp3",
  label: "new",
  quality: "320",
  source: {
    id: "song",
    platform: "test",
    name: "song",
    links: [{ name: "320", quality: 320, format: "mp3", size: "0" }],
  },
  resolveURL: async () => ({
    url: "https://example.test/fresh",
    format: "mp3",
  }),
  url: "https://example.test/OLD_SIGNED",
};

describe("LocalDownloadSession candidate persistence seam", () => {
  it("restores success/failure and converts unfinished tasks without touching the backend", async () => {
    const { session, access } = setup([
      snapshot(),
      snapshot("success", { phase: "success", done: true, committed: true }),
      snapshot("failure", { phase: "failed", done: true }),
    ]);
    await session.restored;
    expect(session.tasks.value).toMatchObject([
      {
        id: "old",
        phase: "failed",
        done: true,
        interrupted: true,
        retryable: true,
      },
      { id: "success", phase: "success", retryable: false },
      { id: "failure", phase: "failed", retryable: true },
    ]);
    expect(access.read).not.toHaveBeenCalled();
    expect(access.start).not.toHaveBeenCalled();
    expect(await session.retire("success")).toBe(true);
    expect(session.tasks.value.map((task) => task.id)).toEqual(["old", "failure"]);
  });

  it("retries archived metadata using a new operation ID, current grant and newly resolved URL", async () => {
    const { session, access, resolveURL } = setup();
    await session.restored;
    const id = await session.retry("old");
    expect(id).toBeTruthy();
    expect(id).not.toBe("old");
    expect(resolveURL).toHaveBeenCalledOnce();
    expect(access.start).toHaveBeenCalledWith({
      operationId: id,
      grantToken: "new-grant",
      filename: "song.mp3",
      url: "https://example.test/NEW_SIGNED",
    });
  });

  it("does not start when a current directory grant disappears during URL resolution", async () => {
    const { session, access, resolveURL, deps } = setup();
    await session.restored;
    const pending = deferred<{ url: string; format: string }>();
    resolveURL.mockReturnValue(pending.promise);
    const retry = session.retry("old");
    await Promise.resolve();
    deps.directoryToken.mockReturnValue(undefined);
    pending.resolve({ url: "https://example.test/fresh", format: "mp3" });
    expect(await retry).toBeUndefined();
    expect(access.start).not.toHaveBeenCalled();
  });

  it("merges late loaded history without overwriting an active task", async () => {
    const loaded = deferred<LocalDownloadSnapshot[]>();
    const { session, persistence } = setup(loaded.promise);
    const id = (await session.start(input))!;
    expect(persistence.save).not.toHaveBeenCalled();
    loaded.resolve([snapshot(), snapshot(id, { label: "stale" })]);
    await session.restored;
    expect(session.tasks.value.find((task) => task.id === id)).toMatchObject({
      label: "new",
      phase: "active",
      done: false,
    });
    expect(session.tasks.value).toHaveLength(2);
    await vi.waitFor(() => expect(persistence.save).toHaveBeenCalledOnce());
  });

  it("preserves the durable active snapshot on dispose and ignores late restore after dispose", async () => {
    const { session, persistence } = setup([]);
    await session.restored;
    await session.start(input);
    await vi.waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(2));
    session.dispose();
    await Promise.resolve();
    expect(persistence.save).toHaveBeenCalledTimes(2);
    const delayed = deferred<LocalDownloadSnapshot[]>();
    const { session: late, persistence: lateStorage } = setup(delayed.promise);
    late.dispose();
    delayed.resolve([snapshot()]);
    await late.restored;
    expect(late.tasks.value).toEqual([]);
    expect(lateStorage.save).not.toHaveBeenCalled();
  });

  it("reports load failure and never overwrites corrupt history", async () => {
    const loaded = deferred<LocalDownloadSnapshot[]>();
    const { session, persistence } = setup(loaded.promise);
    loaded.reject(new Error("corrupt"));
    await session.restored;
    await session.start(input);
    await Promise.resolve();
    expect(session.persistenceError.value).toBe("mygo.downloads.loadFailed");
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it("serializes session saves and exposes storage failure", async () => {
    const { session, persistence } = setup([]);
    await session.restored;
    await vi.waitFor(() => expect(persistence.save).toHaveBeenCalledOnce());
    const write = deferred<void>();
    persistence.save.mockReturnValueOnce(write.promise);
    const id = (await session.start(input))!;
    await session.refresh(id);
    expect(persistence.save).toHaveBeenCalledTimes(2);
    write.reject(new Error("quota"));
    persistence.save.mockRejectedValue(new Error("quota"));
    await vi.waitFor(() =>
      expect(session.persistenceError.value).toBe("mygo.downloads.saveFailed"),
    );
  });

  it("accepts >32MiB progress, keeps polling beyond two minutes, and permits all eleven extensions", async () => {
    vi.useFakeTimers();
    const { session, access } = setup([]);
    await session.restored;
    const id = (await session.start(input))!;
    await session.refresh(id);
    expect(session.tasks.value[0]).toMatchObject({
      phase: "active",
      received: 2 ** 40,
    });
    await vi.advanceTimersByTimeAsync(121000);
    const reads = access.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(access.read.mock.calls.length).toBeGreaterThan(reads);
    for (const format of LOCAL_DOWNLOAD_FORMATS)
      expect(validDownloadFilename(`song.${format}`)).toBe(true);
  });

  it("does not let more than 64 history rows consume live download capacity", async () => {
    const { session, access } = setup(
      Array.from({ length: 70 }, (_, i) => snapshot(String(i), { done: true, phase: "failed" })),
    );
    await session.restored;
    expect(await session.start(input)).toBeTruthy();
    expect(access.start).toHaveBeenCalledOnce();
  });
  it("waits for old writes before a replacement session loads history", async () => {
    let disk: LocalDownloadSnapshot[] = [snapshot("A")];
    const gate = deferred<void>();
    let writes = 0;
    const storage = {
      load: vi.fn(async () => structuredClone(disk)),
      save: vi.fn(async (rows: readonly LocalDownloadSnapshot[]) => {
        if (++writes === 2) await gate.promise;
        disk = structuredClone([...rows]);
      }),
    };
    const first = setup([]);
    first.session.dispose();
    const old = new LocalDownloadSession({ ...first.deps, persistence: storage });
    sessions.push(old);
    await old.restored;
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
    const id = await old.start(input);
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2));
    const closing = old.dispose();
    const next = new LocalDownloadSession({
      ...first.deps,
      persistence: storage,
      deferRestore: true,
    });
    sessions.push(next);
    expect(storage.load).toHaveBeenCalledTimes(1);
    gate.resolve();
    await closing;
    await next.restoreHistory();
    expect(next.tasks.value.map((task) => task.id)).toContain(id);
    expect(next.tasks.value.map((task) => task.id)).toContain("A");
  });
  it("persists a supported download when its song also offers unsupported alternatives", async () => {
    const { session, persistence } = setup([]);
    await session.restored;
    const id = await session.start({
      ...input,
      source: {
        ...input.source,
        links: [
          ...input.source.links,
          { name: "unsupported", quality: 1, format: "xyz", size: "1" },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(persistence.save.mock.calls.at(-1)?.[0].some((row) => row.id === id)).toBe(true),
    );
    expect(() => session.invalidate("new-grant")).not.toThrow();
    await session.dispose();
    const saved = persistence.save.mock.calls.at(-1)?.[0];
    expect(saved?.find((row) => row.id === id)?.source?.links.map((link) => link.format)).toEqual([
      "mp3",
    ]);
    expect(session.persistenceError.value).toBeUndefined();
  });
  it("still cancels and removes a live task if its archive projection fails", async () => {
    const { session, access } = setup([]);
    await session.restored;
    await session.start({
      ...input,
      source: { ...input.source, links: [{ ...input.source.links[0], quality: Infinity }] },
    });
    expect(() => session.invalidate("new-grant")).not.toThrow();
    await vi.waitFor(() => expect(access.cancel).toHaveBeenCalledOnce());
    expect(session.tasks.value).toEqual([]);
    expect(session.persistenceError.value).toBe("mygo.downloads.saveFailed");
    await session.dispose();
  });
});
